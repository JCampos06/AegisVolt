/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Versión de la imagen (git sha). La fija el Dockerfile con --build-arg APP_VERSION. */
  readonly VITE_APP_VERSION?: string;
  /** URL del gateway. Por defecto /graphql del mismo host (Ingress o proxy de Vite). */
  readonly VITE_GRAPHQL_URL?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
