// Runs only after upload succeeds. No production credentials or data are accessed.
module.exports = async function pruneBackups({github, context, core, artifactId}) {
  const id = Number(artifactId);
  if (!Number.isSafeInteger(id) || id <= 0) throw Error('Missing new backup artifact ID; cleanup stopped.');
  const api = github.rest.actions, repo = context.repo;
  const {data: current} = await api.getArtifact({...repo, artifact_id: id});
  const expectedName = new RegExp(`^rfm-owner-backup-${context.runId}-[0-9]+$`);
  if (current.expired || !(current.size_in_bytes > 0) || !expectedName.test(current.name) ||
      current.workflow_run?.id !== context.runId || current.workflow_run?.head_branch !== 'main' ||
      !Number.isFinite(Date.parse(current.created_at))) {
    throw Error('New backup could not be verified; older backups retained.');
  }
  const {data: run} = await api.getWorkflowRun({...repo, run_id: context.runId});
  if (!run.workflow_id || run.head_branch !== 'main') throw Error('Unexpected backup run; cleanup stopped.');
  const artifacts = await github.paginate(api.listArtifactsForRepo, {...repo, per_page: 100});
  const runs = new Map([[context.runId, run]]);
  let removed = 0;
  for (const old of artifacts) {
    if (old.id === id || !/^rfm-owner-backup-[0-9]+-[0-9]+$/.test(old.name) ||
        old.workflow_run?.head_branch !== 'main' ||
        !(Date.parse(old.created_at) < Date.parse(current.created_at))) continue;
    const runId = old.workflow_run.id;
    if (!runs.has(runId)) {
      const {data} = await api.getWorkflowRun({...repo, run_id: runId});
      runs.set(runId, data);
    }
    if (runs.get(runId).workflow_id !== run.workflow_id) continue;
    await api.deleteArtifact({...repo, artifact_id: old.id});
    removed++;
  }
  core.info(`Kept the new backup; removed ${removed} older backup artifact(s).`);
};
