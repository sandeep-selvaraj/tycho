import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type TychoApi } from '@tycho/core';

const api: TychoApi = {
  overview: () => ipcRenderer.invoke(IPC.overview),
  sessions: (q) => ipcRenderer.invoke(IPC.sessions, q),
  session: (id) => ipcRenderer.invoke(IPC.session, id),
  sources: () => ipcRenderer.invoke(IPC.sources),
  tools: (q) => ipcRenderer.invoke(IPC.tools, q),
  harnesses: (q) => ipcRenderer.invoke(IPC.harnesses, q),
  search: (q) => ipcRenderer.invoke(IPC.search, q),
  costPeriods: (q) => ipcRenderer.invoke(IPC.costPeriods, q),
  costSessions: (q) => ipcRenderer.invoke(IPC.costSessions, q),
  onChange: (cb) => {
    const listener = (_e: unknown, topic: Parameters<typeof cb>[0]) => cb(topic);
    ipcRenderer.on(IPC.change, listener);
    return () => ipcRenderer.off(IPC.change, listener);
  },
  onOpenSession: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on(IPC.openSession, listener);
    return () => ipcRenderer.off(IPC.openSession, listener);
  },
};

contextBridge.exposeInMainWorld('tycho', api);
