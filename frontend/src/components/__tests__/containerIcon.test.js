import { describe, expect, it } from "vitest";
import { containerIconUrl, iconCandidates } from "../containerIcon";

const logo = (name) => `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/webp/${name}.webp`;

describe("containerIconUrl", () => {
  it("matches the last path segment of the image, without registry, namespace or tag", () => {
    expect(containerIconUrl({ image: "lscr.io/linuxserver/sonarr:latest", name: "x" })).toBe(logo("sonarr"));
    expect(containerIconUrl({ image: "jellyfin/jellyfin@sha256:abc", name: "x" })).toBe(logo("jellyfin"));
  });

  it("falls back to the container name", () => {
    expect(containerIconUrl({ image: "someone/custom-build:1", name: "grafana" })).toBe(logo("grafana"));
  });

  it("drops a compose replica number", () => {
    expect(containerIconUrl({ name: "uptime-kuma-1" })).toBe(logo("uptime-kuma"));
  });

  it("strips a suffix the image adds to the app's name", () => {
    expect(containerIconUrl({ image: "portainer/portainer-ce:2.19" })).toBe(logo("portainer"));
  });

  it("uses an alias where the set spells the name differently", () => {
    expect(containerIconUrl({ image: "pihole/pihole:latest" })).toBe(logo("pi-hole"));
  });

  it("prefers the image over the name", () => {
    expect(iconCandidates({ image: "lscr.io/linuxserver/radarr", name: "sonarr" })).toEqual(["radarr", "sonarr"]);
  });

  it("returns null rather than guessing", () => {
    expect(containerIconUrl({ image: "someone/homebrew-thing:1", name: "my-thing-1" })).toBeNull();
    expect(containerIconUrl({})).toBeNull();
    expect(containerIconUrl(null)).toBeNull();
  });
});
