export type BuildRelease = {
  revision: string;
  tree: string;
  dirty: boolean;
  provenance: string;
};

declare const __BTC_RELEASE__: BuildRelease;

export const BUILD_RELEASE: Readonly<BuildRelease> = Object.freeze(
  typeof __BTC_RELEASE__ === "undefined"
    ? { revision: "unavailable", tree: "unavailable", dirty: true, provenance: "unavailable" }
    : __BTC_RELEASE__,
);
