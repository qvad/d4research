import { showBootError } from "./lib/bootError";
import { installChunkLoadRecovery } from "./lib/chunkReloadGuard";
import { retireServiceWorker } from "./serviceWorkerRegistration";

const chunkRecovery = installChunkLoadRecovery();
void retireServiceWorker();

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main")
  .then(({ startup }) => startup)
  .then(() => chunkRecovery.completeStartup())
  .catch(showBootError);
