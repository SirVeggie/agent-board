import fs from "node:fs";
import path from "node:path";

// Stage before closing any windows. Keep the old executable until replacement succeeds.
export async function installRelease({ built, installed, runningApps, stop, restart, io = fs }) {
  io.mkdirSync(path.dirname(installed), { recursive: true });
  const staging = io.mkdtempSync(path.join(path.dirname(installed), ".scribe-install-"));
  const staged = path.join(staging, "new.exe");
  const backup = path.join(staging, "previous.exe");
  let backedUp = false;
  let preserveBackup = false;
  let closing = false;
  let apps = [];
  try {
    io.copyFileSync(built, staged);
    apps = runningApps();
    if (apps.length) {
      closing = true;
      stop();
    }
    if (io.existsSync(installed)) {
      io.renameSync(installed, backup);
      backedUp = true;
    }
    io.renameSync(staged, installed);
  } catch (error) {
    const errors = [error];
    if (backedUp) {
      try {
        io.renameSync(backup, installed);
      } catch (restoreError) {
        preserveBackup = true;
        errors.push(new Error(`Could not restore the previous executable; it is saved at ${backup}`, { cause: restoreError }));
      }
    }
    if (closing && !preserveBackup) {
      for (const app of apps) {
        try {
          await restart(app, true);
        } catch (restartError) {
          errors.push(restartError);
        }
      }
    }
    throw errors.length === 1 ? error : new AggregateError(errors, "Installation failed during recovery");
  } finally {
    if (!preserveBackup) {
      try {
        io.rmSync(staging, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Could not remove installer staging folder ${staging}: ${error.message}`);
      }
    }
  }
  if (apps.length) await restart(installed, false);
}
