import { checkPermission, type PermissionGrant } from "../pagePermissions.js";

/** Defence in depth for page uploads; chat transcription does not consume these limits. */
export class PageAudio {
  private calls = new Map<string, number[]>();
  constructor(private grants: (id: string) => Map<string, PermissionGrant>, private now = Date.now) {}
  check(id: string) {
    let grants;
    try { grants = this.grants(id); } catch { return { ok: false, error: "denied", permission: "audio.transcribe" }; }
    if (checkPermission(grants, { perm: "audio.transcribe" }) !== "allow")
      return { ok: false, error: "denied", permission: "audio.transcribe" };
    const now = this.now();
    const times = (this.calls.get(id) ?? []).filter(t => now - t < 3600000);
    if (times.length >= 60 || times.filter(t => now - t < 60000).length >= 6)
      return { ok: false, error: "rate_limited" };
    times.push(now); this.calls.set(id, times);
    return { ok: true };
  }
}
