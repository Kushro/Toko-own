/** The user's release preferences from `SourceOptions`: keywords to exclude and a preferred resolution. */

/** True when the release name contains any exclusion keyword (case-insensitive). */
export function hitsExclusion(title: string, exclusions: string[] | undefined): boolean {
  if (!exclusions?.length) return false;
  const lower = title.toLowerCase();
  return exclusions.some(kw => {
    const k = String(kw ?? '').trim().toLowerCase();
    return k.length > 0 && lower.includes(k);
  });
}

/** True when the release name states `resolution` ("1080p" or "1080"); always true when none is requested. */
export function matchesResolution(title: string, resolution: string | undefined): boolean {
  const digits = String(resolution ?? '').match(/\d{3,4}/)?.[0];
  if (!digits) return true;
  return new RegExp(`(?<!\\d)${digits}p?(?!\\d)`, 'i').test(title);
}
