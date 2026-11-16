/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
declare module '*.css';
declare module '*.md?raw' {
  const text: string;
  export default text;
}
interface Window {
  tycho: import('@tycho/core').TychoApi;
}
