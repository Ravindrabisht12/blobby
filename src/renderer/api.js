// The UI talks to the Electron main process through the preload bridge (window.blobby).
// fileUrl() points at project files served by the app's blobby:// protocol.

const enc = encodeURIComponent;

export const api = {
  ...window.blobby,
  fileUrl: (project, rel, query = '') => `blobby://local/p/${enc(project)}/${rel}${query ? `?${query}` : ''}`,
};
