import { store } from "../store.js";
import { dataDir } from "../config.js";
import { searchEmbedder } from "./embedder.js";
import { detectSearchPack, searchEnabled } from "./pack.js";
import { SearchIndex } from "./indexer.js";

export const searchIndex = new SearchIndex(dataDir, {
  pages: () => [...store.listOpenTabs(), ...store.listClosedTabs()],
  get: id => store.get(id),
  folder: tab => store.folderPath(tab.folderId),
  declaration: tab => store.searchDeclaration(tab),
}, searchEmbedder);

let attached = false;
export function refreshSearchIndex(): void {
  if (!attached) {
    attached = true;
    store.on("tab_upserted", (tab: { id: string }) => searchIndex.schedule(tab.id));
    store.on("tab_state", (tab: { id: string }) => searchIndex.schedule(tab.id));
    store.on("tab_deleted", (id: string) => searchIndex.remove(id));
    store.on("folders", () => { for (const tab of [...store.listOpenTabs(), ...store.listClosedTabs()]) searchIndex.schedule(tab.id); });
    store.on("template_upserted", () => { for (const tab of [...store.listOpenTabs(), ...store.listClosedTabs()]) searchIndex.schedule(tab.id); });
  }
  const pack = detectSearchPack();
  if (searchEnabled() && pack.status === "ready" && pack.pack) {
    try { searchIndex.start(pack.pack.model, pack.pack.dtype); }
    catch (error) { searchIndex.fail(error); searchEmbedder.stop(); }
  }
  else { searchIndex.pause(); searchEmbedder.stop(); }
}
