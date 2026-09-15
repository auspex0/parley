import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// One startup snapshot. Versioned asset URLs prevent an older page that is
// still loading during a restart from receiving a different script or style.
export function snapshotClientAssets(directory) {
  const template = fs.readFileSync(path.join(directory, "index.html"), "utf8");
  const assets = new Map();
  for (const [name, type] of [["styles.css", "text/css"], ["app.js", "text/javascript"]]) {
    if (template.includes(`/ui/${name}`)) assets.set(`/ui/${name}`, {
      body: fs.readFileSync(path.join(directory, name)), type: `${type}; charset=utf-8`,
    });
  }
  const hash = crypto.createHash("sha256").update(template);
  for (const [name, asset] of assets) hash.update(name).update(asset.body);
  const version = hash.digest("hex").slice(0, 20);
  return { html: template.replaceAll("__PARLEY_ASSET_VERSION__", version), version, assets };
}
