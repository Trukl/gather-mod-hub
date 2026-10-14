#!/usr/bin/env node
// Sends, lists and deletes the announcements shown by the mod. Needs ADMIN_TOKEN.
//   npm run announce -- list
//   npm run announce -- post "Maintenance" "The hub is down until 18:00." [--warning] [--hours 2]
//   npm run announce -- post "New" "Edit your animations." --outdated fun=1.5.0
//     (--outdated: only mods running one of these modules below that version)
//   npm run announce -- delete <id>
const HUB_URL = process.env.HUB_URL || "https://gather-mods-hub.minnecorentin.workers.dev";
const token = process.env.ADMIN_TOKEN;
const [command, ...args] = process.argv.slice(2);

function option(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
}
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 && args.splice(i, 1).length > 0;
}

async function call(path, init = {}) {
  const r = await fetch(HUB_URL + path, {
    ...init,
    headers: { ...init.headers, Authorization: "Bearer " + token },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${body.error}`);
  return body;
}

async function main() {
  if (command === "list") {
    const { announcements } = await call("/announcements");
    if (!announcements.length) console.log("No active announcement.");
    for (const a of announcements) {
      const audience = a.outdated
        ? `, for ${Object.entries(a.outdated)
            .map(([id, v]) => `${id} < ${v}`)
            .join(" or ")}`
        : "";
      console.log(
        `${a.id}  [${a.level}] ${a.title}: ${a.message}  (until ${a.expiresAt}${audience})`,
      );
    }
    return;
  }
  if (!token) throw new Error("set ADMIN_TOKEN");
  if (command === "post") {
    const hours = option("--hours");
    const outdated = option("--outdated");
    const level = flag("--warning") ? "warning" : "info";
    const [title, message] = args;
    const { announcement } = await call("/announcements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        message,
        level,
        ...(hours && { hours: Number(hours) }),
        ...(outdated && {
          outdated: Object.fromEntries(outdated.split(",").map((pair) => pair.split("="))),
        }),
      }),
    });
    console.log(`Posted ${announcement.id}, until ${announcement.expiresAt}`);
    return;
  }
  if (command === "delete") {
    await call(`/announcements/${args[0]}`, { method: "DELETE" });
    console.log(`Deleted ${args[0]}`);
    return;
  }
  throw new Error(
    "usage: announce list | post <title> <message> [--warning] [--hours N] [--outdated module=x.y.z,…] | delete <id>",
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
