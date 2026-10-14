/** The checksum inventory must come from the trusted GitHub release (or a build
 * pin), independently of the module CDN. Verify raw manifest bytes before use. */
export declare function verifyManifest(bytes: any, checksums: any): Promise<{
    manifest: any;
    manifestSha256: any;
}>;
export declare function connect(instance: any): {
    api: any;
    call(name: any, ...strings: any[]): string | undefined;
};
/** createLoader({manifest, manifestSha256, baseURL, fetchBytes?, compiledModules?, onProgress?})
 * compiledModules is a trusted deployment binding: {id: {module, sha256}}.
 * Byte downloads are SHA-256 verified before compilation. All module identities
 * are checked even for precompiled Worker bindings. No partial result on error.
 */
export declare function createLoader({ manifest, manifestSha256, baseURL, fetchBytes, compiledModules, onProgress }: {
    baseURL: any;
    compiledModules?: {} | undefined;
    fetchBytes: any;
    manifest: any;
    manifestSha256: any;
    onProgress?: (() => void) | undefined;
}): {
    /** files: iterable [snapshot-relative path, UTF-8 source]. Returns {dataset, reportJson} from one core score. */
    scan(files: any, { repo, label, config }?: {
        config?: string | undefined;
        label?: any;
        repo?: string | undefined;
    }): Promise<{
        dataset: any;
        reportJson: any;
    }>;
};
