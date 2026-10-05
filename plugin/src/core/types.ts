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

export interface Snapshot {
  bu: string
  /** Marketing Cloud account / MID of the BU, if known */
  mid?: string
  pulledAt?: string
  dataExtensions: DataExtension[]
  content: ContentAsset[]
}

export type ChangeType = 'added' | 'changed' | 'removed' | 'unchanged'

export interface AssetChange {
  kind: Asset['kind']
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
