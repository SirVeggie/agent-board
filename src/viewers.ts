import type { WebSocket } from "ws";

export const EDIT_GRACE_MS = 5000;

export type Viewer = {
  socket: WebSocket;
  selectedId: string | null;
  lastInteractedAt: number;
  lastEditAt: number;
  connectedAt: number;
};

export class ViewerHub {
  private viewers = new Map<WebSocket, Viewer>();

  add(socket: WebSocket): Viewer {
    const viewer: Viewer = {
      socket,
      selectedId: null,
      lastInteractedAt: 0,
      lastEditAt: 0,
      connectedAt: Date.now(),
    };
    this.viewers.set(socket, viewer);
    return viewer;
  }

  remove(socket: WebSocket): void {
    this.viewers.delete(socket);
  }

  update(
    socket: WebSocket,
    patch: { selectedId?: string | null; lastInteractedAt?: unknown; lastEditAt?: unknown }
  ): void {
    const viewer = this.viewers.get(socket);
    if (!viewer) {
      return;
    }
    if (patch.selectedId === null || typeof patch.selectedId === "string") {
      viewer.selectedId = patch.selectedId;
    }
    if (typeof patch.lastInteractedAt === "number" && Number.isFinite(patch.lastInteractedAt)) {
      viewer.lastInteractedAt = Math.max(viewer.lastInteractedAt, patch.lastInteractedAt);
    }
    if (typeof patch.lastEditAt === "number" && Number.isFinite(patch.lastEditAt)) {
      viewer.lastEditAt = Math.max(viewer.lastEditAt, patch.lastEditAt);
    }
  }

  count(): number {
    return this.viewers.size;
  }

  /**
   * Who should switch to `tabId` after an activating page update.
   * `already-visible` = some window is already on that tab; nobody switches.
   * `null` = blocked (recent edit) or no viewers.
   */
  focusTarget(tabId: string): Viewer | "already-visible" | null {
    const list = [...this.viewers.values()];
    if (list.length === 0) {
      return null;
    }
    if (list.some((viewer) => viewer.selectedId === tabId)) {
      return "already-visible";
    }
    const target = pickLatest(list);
    if (target.lastEditAt > 0 && Date.now() - target.lastEditAt < EDIT_GRACE_MS) {
      return null;
    }
    return target;
  }
}

function pickLatest(list: Viewer[]): Viewer {
  return list.reduce((best, viewer) => {
    const a = viewer.lastInteractedAt || viewer.connectedAt;
    const b = best.lastInteractedAt || best.connectedAt;
    return a >= b ? viewer : best;
  });
}
