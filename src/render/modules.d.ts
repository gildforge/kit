declare module 'gild:browser-assets' {
  const assets: Record<string, Uint8Array<ArrayBuffer>>
  export default assets
}

declare module 'gild:asset-manifest' {
  const manifest: { urls: Record<string, string>; hash: string }
  export default manifest
}

declare module 'gild:tab-skeletons' { const value: Record<string, string>; export default value }
declare module 'gild:tab-styles' { const styles: string[]; export default styles }
