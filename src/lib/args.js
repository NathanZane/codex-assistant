export function parseArgs(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const rawKey = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
    const key = toCamel(rawKey);

    if (eqIndex !== -1) {
      options[key] = coerceValue(arg.slice(eqIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = coerceValue(next);
    index += 1;
  }

  return { options, positionals };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function coerceValue(value) {
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}
