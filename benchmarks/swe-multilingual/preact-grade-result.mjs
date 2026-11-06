export function classifyPreactGrade({
  output,
  status,
  error,
  signal,
  expectedFail,
  expectedPass,
}) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const has = (mark, name) => text.includes(`${mark} ${name}`);
  const failedFailToPass = expectedFail.filter((name) => has("✖", name));
  const failedPassToPass = expectedPass.filter((name) => has("✖", name));
  const missingFailToPass = expectedFail.filter((name) => !has("✔", name));
  const missingPassToPass = expectedPass.filter(
    (name) => !has("✔", name) && !has("✖", name),
  );
  const unknownFailToPass = missingFailToPass.filter(
    (name) => !failedFailToPass.includes(name),
  );
  const infrastructureError = Boolean(
    error ||
    signal ||
    status === null ||
    /Chrome failed .*cannot start/i.test(text) ||
    !/Finished in .*secs/.test(text),
  );
  const complete =
    !infrastructureError &&
    unknownFailToPass.length === 0 &&
    missingPassToPass.length === 0 &&
    (status === 0 ||
      failedFailToPass.length > 0 ||
      failedPassToPass.length > 0);
  const passed = complete
    ? failedFailToPass.length === 0 &&
      failedPassToPass.length === 0 &&
      status === 0
    : null;
  return {
    passed,
    complete,
    missingFailToPass,
    failedFailToPass,
    failedPassToPass,
    missingPassToPass,
  };
}
