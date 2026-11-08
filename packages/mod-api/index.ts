export type ModSetting = { key: string; label: string; description?: string } & (
  | { type: 'select'; options: { value: string | number; label: string }[]; default: string | number }
  | { type: 'number'; default: number; min?: number; max?: number; integer?: boolean }
  | { type: 'boolean'; default: boolean }
)

export type ModValues = Record<string, string | number | boolean>

export type Mod = {
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  settings?: ModSetting[]
}
