import { ExpiringCache, type CachedValue } from "./cache.js";
import { type ResolvedShare, TeraBoxClient } from "./terabox.js";

export interface ScannedFile {
  /** Path of the parent directory that held this item ("" = share root). */
  directory: string;
  /** Absolute TeraBox path, used to re-enter that folder for browsing. */
  folderPath: string;
  /** Display path relative to the scan root, e.g. "Videos/clip.mp4". */
  relativePath: string;
  name: string;
  sizeBytes?: number;
  download?: string;
  isFolder: boolean;
}

export interface ResolveOptions {
  pwd?: string;
}

/** Maximum folder depth and item count a single recursive scan will follow. */
const MAX_SCAN_DEPTH = 15;
const MAX_SCAN_ITEMS = 10_000;

export interface ShareResolver {
  resolve(surl: string, directory?: string, opts?: ResolveOptions): Promise<CachedValue<ResolvedShare>>;
  /** Recursively walk every sub-folder and return all files (and folders). */
  scanAll(surl: string, startDirectory?: string, opts?: ResolveOptions): Promise<ScannedFile[]>;
  /** Replace the TeraBox cookies at runtime (Telegram /setcookie). */
  setCookies?(cookies: Record<string, string>): void;
  getCookieNames?(): string[];
  readonly cacheSize: number;
}

function joinPath(base: string, name: string): string {
  if (!base) {
    return `/${name}`;
  }
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function relativeDisplayPath(directory: string, name: string): string {
  if (!directory) {
    return name;
  }
  return `${directory.replace(/^\/+|\/+$/g, "")}/${name}`;
}

export class CachedShareService implements ShareResolver {
  constructor(
    private readonly client: TeraBoxClient,
    private readonly cache: ExpiringCache<ResolvedShare>,
  ) {}

  get cacheSize(): number {
    return this.cache.size;
  }

  setCookies(cookies: Record<string, string>): void {
    this.client.setCookies(cookies);
    this.cache.clear();
  }

  getCookieNames(): string[] {
    return this.client.getCookieNames();
  }

  resolve(surl: string, directory?: string, opts?: ResolveOptions): Promise<CachedValue<ResolvedShare>> {
    const normalizedDirectory = directory?.trim() || "";
    const pwdKey = opts?.pwd ? `|pwd:${opts.pwd}` : "";
    const cacheKey = `${surl}\u0000${normalizedDirectory}${pwdKey}`;
    return this.cache.getOrLoad(cacheKey, () =>
      this.client.resolve(surl, normalizedDirectory || undefined, opts),
    );
  }

  async scanAll(surl: string, startDirectory?: string, opts?: ResolveOptions): Promise<ScannedFile[]> {
    const results: ScannedFile[] = [];
    const seen = new Set<string>();
    let itemCount = 0;

    const walk = async (directory: string | undefined, depth: number): Promise<void> => {
      if (depth > MAX_SCAN_DEPTH) {
        return;
      }
      const dirKey = directory ?? "";
      if (seen.has(dirKey)) {
        return;
      }
      seen.add(dirKey);

      const { value: share } = await this.resolve(surl, directory, opts);
      for (const file of share.files) {
        itemCount += 1;
        if (itemCount > MAX_SCAN_ITEMS) {
          return;
        }
        results.push({
          directory: directory ?? "",
          folderPath: file.path ?? joinPath(dirKey, file.name),
          relativePath: relativeDisplayPath(directory ?? "", file.name),
          name: file.name,
          sizeBytes: file.sizeBytes,
          download: file.download,
          isFolder: file.isFolder,
        });
        if (file.isFolder) {
          const nextDirectory = file.path ?? joinPath(dirKey, file.name);
          await walk(nextDirectory, depth + 1);
        }
      }
    };

    await walk(startDirectory?.trim() || undefined, 0);
    return results;
  }
}
