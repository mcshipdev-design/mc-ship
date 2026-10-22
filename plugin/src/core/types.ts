export type FieldType =
  | 'Text'
  | 'Number'
  | 'Date'
  | 'Boolean'
  | 'EmailAddress'
  | 'Phone'
  | 'Decimal'
  | 'Locale'

export interface DeField {
  name: string
  type: FieldType
  length?: number
  isPrimaryKey?: boolean
  isRequired?: boolean
}

export interface DataExtension {
  kind: 'dataExtension'
  customerKey: string
  name: string
  isSendable?: boolean
  /** Field used as the send relationship when isSendable is true */
  sendableField?: string
  /** Days rows are kept. Undefined = no retention policy */
  retentionDays?: number
  fields: DeField[]
  /** Rows currently in the DE. Only known for snapshots pulled from a BU */
  rowCount?: number
}

export type ContentAssetType = 'htmlemail' | 'htmlblock' | 'template'

export interface ContentAsset {
  kind: 'content'
  customerKey: string
  name: string
  assetType: ContentAssetType
  subject?: string
  /** HTML / AMPscript body */
  content: string
}

export type Asset = DataExtension | ContentAsset

// ---------------- Automation Studio ----------------

export type QueryUpdateType = 'Overwrite' | 'Update' | 'Append'

/** A SQL Query Activity. Deployed by MC Ship. */
export interface QueryActivity {
  kind: 'query'
  customerKey: string
  name: string
  /** The SQL text */
  sql: string
  /** Customer key of the target Data Extension */
  targetKey: string
  targetName?: string
  updateType: QueryUpdateType
}

export interface AutomationActivity {
  /** query, script, import, email, filetransfer, dataextract, filter, wait, or "type <id>" */
  type: string
  name: string
  /** Customer key of the activity when MC Ship knows it (queries) */
  key?: string
}

/** An Automation Studio automation. Pulled, diffed and checked; never deployed by MC Ship. */
export interface Automation {
  kind: 'automation'
  customerKey: string
  name: string
  status?: string
  steps: {step: number; activities: AutomationActivity[]}[]
}

export interface Snapshot {
  bu: string
  /** Marketing Cloud account / MID of the BU, if known */
  mid?: string
  pulledAt?: string
  dataExtensions: DataExtension[]
  content: ContentAsset[]
  queries?: QueryActivity[]
  automations?: Automation[]
}

export type ChangeType = 'added' | 'changed' | 'removed' | 'unchanged'

export interface AssetChange {
  kind: Asset['kind'] | 'query' | 'automation'
  customerKey: string
  name: string
  change: ChangeType
  /** Human-readable details, e.g. field-level changes */
  details: string[]
}

export type Severity = 'fail' | 'warn'

export interface Finding {
  rule: string
  severity: Severity
  asset: string
  message: string
  fix?: string
}

export interface CheckResult {
  from: string
  to: string
  status: 'pass' | 'warn' | 'fail'
  findings: Finding[]
  rulesRun: string[]
}
