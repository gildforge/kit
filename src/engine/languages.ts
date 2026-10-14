export const LANGUAGES: Record<string, [string, string]> = {
  ts: ['TypeScript', '#3178c6'], tsx: ['TypeScript', '#3178c6'], mts: ['TypeScript', '#3178c6'],
  js: ['JavaScript', '#e8c547'], jsx: ['JavaScript', '#e8c547'], mjs: ['JavaScript', '#e8c547'], cjs: ['JavaScript', '#e8c547'],
  rs: ['Rust', '#dea584'], go: ['Go', '#00add8'], py: ['Python', '#3572a5'], rb: ['Ruby', '#cc342d'],
  swift: ['Swift', '#f05138'], kt: ['Kotlin', '#a97bff'], java: ['Java', '#b07219'], c: ['C', '#8c8c8c'],
  h: ['C', '#8c8c8c'], cc: ['C++', '#f34b7d'], cpp: ['C++', '#f34b7d'], cs: ['C#', '#178600'],
  css: ['CSS', '#663399'], scss: ['SCSS', '#c6538c'], html: ['HTML', '#e34c26'], sql: ['SQL', '#e38c00'],
  sh: ['Shell', '#89e051'], zig: ['Zig', '#ec915c'], dsx: ['DekaScript', '#663399'], ds: ['DekaScript', '#663399'],
}

export const languageFor = (path: string) => LANGUAGES[path.split(".").pop()!.toLowerCase()]?.[0] ?? ""
