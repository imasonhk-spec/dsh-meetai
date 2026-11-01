export class CoreError extends Error {
  constructor(code) { super(code); this.name = 'CoreError'; this.code = code; }
}
export function requireCore(condition, code) { if (!condition) throw new CoreError(code); }
