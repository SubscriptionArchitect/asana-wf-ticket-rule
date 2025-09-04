/**
 * Asana "Run script" (GitHub-backed)
 * In-scope: project_gid, workspace_gid, task_gid, log(...), tasksApiInstance
 * Goal: Append unique, random-looking 8-digit suffix "#WF-XXXXXXXX" to the task title.
 * - Cleans legacy "#wf" tokens
 * - Never reuses a number within the project
 * - Concurrency-safe using task GID + salted fallback
 */

async function run() {
  // ---------- Config & helpers ----------
  const VALID_RE = /#WF-\d{8}\b$/;                 // valid trailing token
  const ANY_WF_RE = /#\s*wf[-\s_]?(\d{1,8})\b/gi;  // legacy/malformed tokens anywhere

  // Stable, random-looking 8-digit from GID + salt (FNV-1a 32-bit)
  function hash8(input, k = 0) {
    let h = 0x811c9dc5;
    const s = String(input) + (k ? `:${k}` : "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0; // *16777619
    }
    const n = h % 100000000; // 0..99,999,999
    return String(n).padStart(8, "0");
  }
  const squashSpaces = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // ---------- Safe paginator (works across different rule runtimes) ----------
  async function fetchAllProjectTasks(projectGid) {
    const all = [];

    // A) getTasksForProject (preferred)
    try {
      let offset;
      while (true) {
        const params = { limit: 100, opt_fields: "gid,name" };
        if (offset) params.offset = offset; // only add when defined
        const page = await tasksApiInstance.getTasksForProject(projectGid, params);
        all.push(...(page.data || []));
        if (page && page.next_page && page.next_page.offset) {
          offset = page.next_page.offset;
        } else {
          return all;
        }
      }
    } catch (eA) {
      log("Fallback A→B: " + (eA && eA.message));
    }

    // B) getTasks with { project }
    try {
      let offset;
      while (true) {
        const params = { project: projectGid, limit: 100, opt_fields: "gid,name" };
        if (offset) params.offset = offset;
        const page = await tasksApiInstance.getTasks(params);
        all.push(...(page.data || []));
        if (page && page.next_page && page.next_page.offset) {
          offset = page.next_page.offset;
        } else {
          return all;
        }
      }
    } catch (eB) {
      log("Fallback B→C: " + (eB && eB.message));
    }

    // C) last resort: return just the current task so we don’t crash
    try {
      const t = await tasksApiInstance.getTask(task_gid, { opt_fields: "gid,name" });
      return [t.data];
    } catch {
      return [];
    }
  }

  // ---------- Fetch the current task ----------
  const taskRes = await tasksApiInstance.getTask(task_gid, {
    opt_fields: "gid,name,custom_fields.name,custom_fields.gid,custom_fields.type",
  });
  const task = taskRes.data;
  const originalName = String(task.name || "");

  // ---------- Build map of already-used tokens in this project ----------
  const projectTasks = await fetchAllProjectTasks(project_gid);
  const tokenOwners = new Map(); // tokenDigits -> [taskGid, ...]

  for (const t of projectTasks) {
    const m = String(t.name || "").match(VALID_RE);
    if (m) {
      const tok = m[0].slice(4); // keep just 8 digits
      const arr = tokenOwners.get(tok) || [];
      arr.push(t.gid);
      tokenOwners.set(tok, arr);
    }
  }

  // If title already ends with a valid token and it's unique → exit
  const currentValid = originalName.match(VALID_RE);
  if (currentValid) {
    const tok = currentValid[0].slice(4);
    const owners = tokenOwners.get(tok) || [];
    if (owners.length === 1 && owners[0] === task.gid) {
      log("Unique #WF-XXXXXXXX already present. Skipping.");
      return;
    }
  }

  // Clean up legacy tokens and normalize spaces
  const baseTitle = squashSpaces(originalName.replace(ANY_WF_RE, ""));

  // Deterministic candidate from task GID; bump salt until unused
  let k = 0;
  let candidate = hash8(task.gid, k);
  while ((tokenOwners.get(candidate) || []).some((gid) => gid !== task.gid)) {
    k += 1;
    candidate = hash8(task.gid, k);
  }

  const finalTitle = `${baseTitle} #WF-${candidate}`;

  // Optional: sync numeric custom field "WF Ticket #"
  const update = { name: finalTitle };
  const wfField = (task.custom_fields || []).find(
    (f) => f && f.name === "WF Ticket #" && f.type === "number"
  );
  if (wfField) {
    update.custom_fields = { [wfField.gid]: Number(candidate) };
  }

  await tasksApiInstance.updateTask(task.gid, update);
  log(`Updated → "${finalTitle}"${wfField ? " + set WF Ticket #." : ""}`);
}

run();
