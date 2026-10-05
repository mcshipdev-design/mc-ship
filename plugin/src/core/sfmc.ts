import fs from 'node:fs'
import path from 'node:path'

import {BuConfig, loadSecret, projectRoot} from './config.js'
import {ContentAsset, DataExtension, DeField, FieldType, Snapshot} from './types.js'

export interface UpsertResult {
  customerKey: string
  action: 'created' | 'updated' | 'skipped'
  note?: string
}

/** What MC Ship needs from a Business Unit. Live and mock clients both implement it. */
export interface McClient {
  /** Cheap call that proves the connection works */
  verify(): Promise<void>
  snapshot(): Promise<Snapshot>
  upsertDataExtension(de: DataExtension, existing?: DataExtension): Promise<UpsertResult>
  upsertContent(asset: ContentAsset): Promise<UpsertResult>
}

export function clientFor(buName: string, bu: BuConfig, root = projectRoot()): McClient {
  return bu.mode === 'mock' ? new MockClient(buName, root) : new LiveClient(buName, bu)
}

// ---------------------------------------------------------------------------
// Mock client: a BU stored as JSON in .mcship/mock/<BU>.json
// Used for demos, tests and CI without touching a real account.
// ---------------------------------------------------------------------------

export function mockFile(buName: string, root = projectRoot()): string {
  return path.join(root, '.mcship', 'mock', `${buName}.json`)
}

export class MockClient implements McClient {
  constructor(private readonly buName: string, private readonly root: string) {}

  private read(): Snapshot {
    const file = mockFile(this.buName, this.root)
    if (!fs.existsSync(file)) return {bu: this.buName, dataExtensions: [], content: []}
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot
  }

  private write(s: Snapshot): void {
    const file = mockFile(this.buName, this.root)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
  }

  async verify(): Promise<void> {
    this.read()
  }

  async snapshot(): Promise<Snapshot> {
    const s = this.read()
    return {...s, bu: this.buName, pulledAt: new Date().toISOString()}
  }

  async upsertDataExtension(de: DataExtension, existing?: DataExtension): Promise<UpsertResult> {
    const s = this.read()
    const i = s.dataExtensions.findIndex((d) => d.customerKey === de.customerKey)
    if (i === -1) {
      s.dataExtensions.push({...de, rowCount: 0})
      this.write(s)
      return {customerKey: de.customerKey, action: 'created'}
    }

    // Same rules as the live API: only new fields can be added in place.
    const current = s.dataExtensions[i]
    const added = de.fields.filter((f) => !current.fields.some((c) => c.name === f.name))
    const blocked = fieldChangesNeedingRebuild(existing ?? current, de)
    const retention = Boolean(de.retentionDays) && de.retentionDays !== current.retentionDays
    current.fields.push(...added)
    if (retention) current.retentionDays = de.retentionDays
    this.write(s)
    return {
      customerKey: de.customerKey,
      action: added.length || retention ? 'updated' : 'skipped',
      note: [
        added.length ? `added fields: ${added.map((f) => f.name).join(', ')}` : 'no new fields',
        retention ? `retention set to ${de.retentionDays} days` : '',
        blocked.length ? `not applied (needs manual rebuild): ${blocked.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('. '),
    }
  }

  async upsertContent(asset: ContentAsset): Promise<UpsertResult> {
    const s = this.read()
    const i = s.content.findIndex((c) => c.customerKey === asset.customerKey)
    if (i === -1) s.content.push(asset)
    else s.content[i] = asset
    this.write(s)
    return {customerKey: asset.customerKey, action: i === -1 ? 'created' : 'updated'}
  }
}

/** Field changes the Marketing Cloud API cannot apply to an existing DE. */
export function fieldChangesNeedingRebuild(before: DataExtension, after: DataExtension): string[] {
  const out: string[] = []
  for (const old of before.fields) {
    const next = after.fields.find((f) => f.name === old.name)
    if (!next) out.push(`${old.name} removed`)
    else {
      if (next.type !== old.type) out.push(`${old.name} type ${old.type} -> ${next.type}`)
      if (Boolean(next.isPrimaryKey) !== Boolean(old.isPrimaryKey)) out.push(`${old.name} primary key changed`)
      if (old.length && next.length && next.length < old.length) out.push(`${old.name} length ${old.length} -> ${next.length}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Live client: Marketing Cloud REST (Content Builder, row counts) + SOAP (DEs)
// ---------------------------------------------------------------------------

interface Token {
  accessToken: string
  restUrl: string
  soapUrl: string
}

const ASSET_TYPE_IDS: Record<ContentAsset['assetType'], number> = {htmlemail: 208, htmlblock: 197, template: 4}

export class LiveClient implements McClient {
  private token?: Token

  constructor(private readonly buName: string, private readonly bu: BuConfig) {
    if (!bu.subdomain || !bu.clientId || !bu.accountId) {
      throw new Error(`BU "${buName}" needs subdomain, clientId and accountId. Run: agentia mc connect ${buName}`)
    }
  }

  async verify(): Promise<void> {
    await this.auth()
  }

  private async auth(): Promise<Token> {
    if (this.token) return this.token
    const res = await fetch(`https://${this.bu.subdomain}.auth.marketingcloudapis.com/v2/token`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.bu.clientId,
        client_secret: loadSecret(this.buName, this.bu),
        account_id: this.bu.accountId,
      }),
    })
    if (!res.ok) throw new Error(`SFMC auth failed for ${this.buName}: HTTP ${res.status} ${await res.text()}`)
    const body = (await res.json()) as {access_token: string; rest_instance_url: string; soap_instance_url: string}
    this.token = {accessToken: body.access_token, restUrl: body.rest_instance_url, soapUrl: body.soap_instance_url}
    return this.token
  }

  private async rest<T>(method: string, route: string, body?: unknown): Promise<T> {
    const t = await this.auth()
    const res = await fetch(new URL(route, t.restUrl), {
      method,
      headers: {Authorization: `Bearer ${t.accessToken}`, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`SFMC REST ${method} ${route} failed: HTTP ${res.status} ${text}`)
    return (text ? JSON.parse(text) : {}) as T
  }

  private async soap(action: 'Retrieve' | 'Create' | 'Update', inner: string): Promise<string> {
    const t = await this.auth()
    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<s:Header><fueloauth xmlns="http://exacttarget.com">${xml(t.accessToken)}</fueloauth></s:Header>` +
      `<s:Body>${inner}</s:Body></s:Envelope>`
    const res = await fetch(new URL('Service.asmx', t.soapUrl), {
      method: 'POST',
      headers: {'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action},
      body: envelope,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`SFMC SOAP ${action} failed: HTTP ${res.status} ${text.slice(0, 500)}`)
    const status = tag(text, 'OverallStatus')
    if (status && !/^(OK|MoreDataAvailable)$/.test(status)) {
      throw new Error(`SFMC SOAP ${action} failed: ${status} ${tag(text, 'StatusMessage') ?? ''}`)
    }
    return text
  }

  private async retrieveAll(objectType: string, props: string[]): Promise<string[]> {
    const results: string[] = []
    let request =
      `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><RetrieveRequest>` +
      `<ObjectType>${objectType}</ObjectType>${props.map((p) => `<Properties>${p}</Properties>`).join('')}` +
      `</RetrieveRequest></RetrieveRequestMsg>`
    for (;;) {
      const text = await this.soap('Retrieve', request)
      results.push(...blocks(text, 'Results'))
      if (tag(text, 'OverallStatus') !== 'MoreDataAvailable') break
      request =
        `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><RetrieveRequest>` +
        `<ContinueRequest>${tag(text, 'RequestID')}</ContinueRequest></RetrieveRequest></RetrieveRequestMsg>`
    }
    return results
  }

  async snapshot(): Promise<Snapshot> {
    const [deRows, fieldRows, content] = await Promise.all([
      this.retrieveAll('DataExtension', ['CustomerKey', 'Name', 'IsSendable', 'DataRetentionPeriodLength', 'DataRetentionPeriod']),
      this.retrieveAll('DataExtensionField', [
        'Name',
        'FieldType',
        'MaxLength',
        'IsPrimaryKey',
        'IsRequired',
        'DataExtension.CustomerKey',
      ]),
      this.contentAssets(),
    ])

    const fieldsByDe = new Map<string, DeField[]>()
    for (const row of fieldRows) {
      const deKey = /<DataExtension>[\s\S]*?<CustomerKey>([\s\S]*?)<\/CustomerKey>/.exec(row)?.[1]
      if (!deKey) continue
      const list = fieldsByDe.get(unxml(deKey)) ?? []
      list.push({
        name: unxml(tag(row, 'Name') ?? ''),
        type: (tag(row, 'FieldType') ?? 'Text') as FieldType,
        length: tag(row, 'MaxLength') ? Number(tag(row, 'MaxLength')) : undefined,
        isPrimaryKey: tag(row, 'IsPrimaryKey') === 'true',
        isRequired: tag(row, 'IsRequired') === 'true',
      })
      fieldsByDe.set(unxml(deKey), list)
    }

    const dataExtensions: DataExtension[] = []
    for (const row of deRows) {
      const customerKey = unxml(tag(row, 'CustomerKey') ?? '')
      const len = Number(tag(row, 'DataRetentionPeriodLength') ?? 0)
      const unit = tag(row, 'DataRetentionPeriod') ?? 'Days'
      const factor: Record<string, number> = {Days: 1, Weeks: 7, Months: 30, Years: 365}
      dataExtensions.push({
        kind: 'dataExtension',
        customerKey,
        name: unxml(tag(row, 'Name') ?? customerKey),
        isSendable: tag(row, 'IsSendable') === 'true',
        retentionDays: len > 0 ? len * (factor[unit] ?? 1) : undefined,
        fields: fieldsByDe.get(customerKey) ?? [],
        rowCount: await this.rowCount(customerKey),
      })
    }

    return {
      bu: this.buName,
      mid: this.bu.accountId,
      pulledAt: new Date().toISOString(),
      dataExtensions,
      content,
    }
  }

  private async rowCount(customerKey: string): Promise<number | undefined> {
    try {
      const r = await this.rest<{count?: number}>(
        'GET',
        `data/v1/customobjectdata/key/${encodeURIComponent(customerKey)}/rowset?$page=1&$pageSize=1`,
      )
      return r.count
    } catch {
      return undefined
    }
  }

  private async contentAssets(): Promise<ContentAsset[]> {
    const out: ContentAsset[] = []
    for (let page = 1; ; page++) {
      const r = await this.rest<{count: number; items: RawAsset[]}>('POST', 'asset/v1/content/assets/query', {
        page: {page, pageSize: 200},
        query: {property: 'assetType.name', simpleOperator: 'in', value: Object.keys(ASSET_TYPE_IDS)},
      })
      for (const a of r.items ?? []) out.push(fromRawAsset(a))
      if (page * 200 >= r.count) break
    }
    return out
  }

  private async findAsset(customerKey: string): Promise<RawAsset | undefined> {
    const r = await this.rest<{items: RawAsset[]}>('POST', 'asset/v1/content/assets/query', {
      page: {page: 1, pageSize: 1},
      query: {property: 'customerKey', simpleOperator: 'equal', value: customerKey},
    })
    return r.items?.[0]
  }

  async upsertContent(asset: ContentAsset): Promise<UpsertResult> {
    const body = toRawAsset(asset)
    const existing = await this.findAsset(asset.customerKey)
    if (existing?.id) {
      await this.rest('PATCH', `asset/v1/content/assets/${existing.id}`, body)
      return {customerKey: asset.customerKey, action: 'updated'}
    }
    await this.rest('POST', 'asset/v1/content/assets', body)
    return {customerKey: asset.customerKey, action: 'created'}
  }

  async upsertDataExtension(de: DataExtension, existing?: DataExtension): Promise<UpsertResult> {
    if (!existing) {
      const sendable =
        de.isSendable && de.sendableField
          ? `<IsSendable>true</IsSendable>` +
            `<SendableDataExtensionField><Name>${xml(de.sendableField)}</Name></SendableDataExtensionField>` +
            `<SendableSubscriberField><Name>Subscriber Key</Name></SendableSubscriberField>`
          : ''
      const retention = de.retentionDays
        ? `<DataRetentionPeriodLength>${de.retentionDays}</DataRetentionPeriodLength><DataRetentionPeriod>Days</DataRetentionPeriod><RowBasedRetention>true</RowBasedRetention>`
        : ''
      await this.soap(
        'Create',
        `<CreateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI"><Objects xsi:type="DataExtension">` +
          `<CustomerKey>${xml(de.customerKey)}</CustomerKey><Name>${xml(de.name)}</Name>${sendable}${retention}` +
          `<Fields>${de.fields.map(fieldXml).join('')}</Fields></Objects></CreateRequest>`,
      )
      return {customerKey: de.customerKey, action: 'created'}
    }

    const added = de.fields.filter((f) => !existing.fields.some((e) => e.name === f.name))
    const blocked = fieldChangesNeedingRebuild(existing, de)
    const retention = Boolean(de.retentionDays) && de.retentionDays !== existing.retentionDays
    if (added.length || retention) {
      await this.soap(
        'Update',
        `<UpdateRequest xmlns="http://exacttarget.com/wsdl/partnerAPI"><Objects xsi:type="DataExtension">` +
          `<CustomerKey>${xml(de.customerKey)}</CustomerKey>` +
          (retention
            ? `<DataRetentionPeriodLength>${de.retentionDays}</DataRetentionPeriodLength><DataRetentionPeriod>Days</DataRetentionPeriod><RowBasedRetention>true</RowBasedRetention>`
            : '') +
          (added.length ? `<Fields>${added.map(fieldXml).join('')}</Fields>` : '') +
          `</Objects></UpdateRequest>`,
      )
    }
    return {
      customerKey: de.customerKey,
      action: added.length || retention ? 'updated' : 'skipped',
      note: [
        added.length ? `added fields: ${added.map((f) => f.name).join(', ')}` : 'no new fields',
        retention ? `retention set to ${de.retentionDays} days` : '',
        blocked.length ? `not applied (needs manual rebuild): ${blocked.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('. '),
    }
  }
}

interface RawAsset {
  id?: number
  customerKey: string
  name: string
  assetType: {id?: number; name: string}
  content?: string
  views?: {html?: {content?: string}; subjectline?: {content?: string}}
}

function fromRawAsset(a: RawAsset): ContentAsset {
  const type = a.assetType.name as ContentAsset['assetType']
  return {
    kind: 'content',
    customerKey: a.customerKey,
    name: a.name,
    assetType: type,
    subject: a.views?.subjectline?.content,
    content: type === 'htmlemail' ? a.views?.html?.content ?? '' : a.content ?? '',
  }
}

function toRawAsset(a: ContentAsset): RawAsset {
  const base: RawAsset = {
    customerKey: a.customerKey,
    name: a.name,
    assetType: {id: ASSET_TYPE_IDS[a.assetType], name: a.assetType},
  }
  if (a.assetType === 'htmlemail') {
    base.views = {html: {content: a.content}, subjectline: {content: a.subject ?? ''}}
  } else base.content = a.content
  return base
}

function fieldXml(f: DeField): string {
  return (
    `<Field><Name>${xml(f.name)}</Name><FieldType>${f.type}</FieldType>` +
    (f.length ? `<MaxLength>${f.length}</MaxLength>` : '') +
    `<IsPrimaryKey>${Boolean(f.isPrimaryKey)}</IsPrimaryKey>` +
    `<IsRequired>${Boolean(f.isRequired || f.isPrimaryKey)}</IsRequired></Field>`
  )
}

// --- tiny XML helpers (SOAP responses are flat enough for this) ---
function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unxml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

function tag(src: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(src)?.[1]
}

function blocks(src: string, name: string): string[] {
  return [...src.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1])
}
