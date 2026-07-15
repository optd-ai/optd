export const ARGON2ID_V1 = Object.freeze({
  profile: "argon2id.v1",
  algorithm: "argon2id",
  version: 19,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});

export type ArgonParameters = {
  algorithm: string;
  version: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  outputLen: number;
};

export type ArgonMaintenancePlan = {
  rehash: boolean;
  updateProfile: boolean;
  target: ArgonParameters;
};

export function parseArgonPhc(phc: string): ArgonParameters | undefined {
  const parts = phc.split("$");
  if (parts.length !== 6 || parts[0] !== "") return undefined;
  const version = parseExactInteger(parts[2], "v");
  const parameters = Object.fromEntries(
    parts[3].split(",").map((entry) => entry.split("=", 2)),
  );
  const memoryCost = parseDecimal(parameters.m);
  const timeCost = parseDecimal(parameters.t);
  const parallelism = parseDecimal(parameters.p);
  const outputLen = decodeBase64Length(parts[5]);
  if (
    !parts[1] || version === undefined || memoryCost === undefined ||
    timeCost === undefined || parallelism === undefined ||
    outputLen === undefined || !parts[4]
  ) return undefined;
  return {
    algorithm: parts[1],
    version,
    memoryCost,
    timeCost,
    parallelism,
    outputLen,
  };
}

export function planArgonMaintenance(
  profile: string,
  stored: ArgonParameters | undefined,
): ArgonMaintenancePlan {
  if (!stored) {
    return { rehash: true, updateProfile: true, target: currentParameters() };
  }
  const target = {
    algorithm: ARGON2ID_V1.algorithm,
    version: ARGON2ID_V1.version,
    memoryCost: Math.max(stored.memoryCost, ARGON2ID_V1.memoryCost),
    timeCost: Math.max(stored.timeCost, ARGON2ID_V1.timeCost),
    parallelism: Math.max(stored.parallelism, ARGON2ID_V1.parallelism),
    outputLen: Math.max(stored.outputLen, ARGON2ID_V1.outputLen),
  };
  const rehash = stored.algorithm !== ARGON2ID_V1.algorithm ||
    stored.version !== ARGON2ID_V1.version ||
    stored.memoryCost < ARGON2ID_V1.memoryCost ||
    stored.timeCost < ARGON2ID_V1.timeCost ||
    stored.parallelism < ARGON2ID_V1.parallelism ||
    stored.outputLen < ARGON2ID_V1.outputLen;
  return { rehash, updateProfile: profile !== ARGON2ID_V1.profile, target };
}

function currentParameters(): ArgonParameters {
  return {
    algorithm: ARGON2ID_V1.algorithm,
    version: ARGON2ID_V1.version,
    memoryCost: ARGON2ID_V1.memoryCost,
    timeCost: ARGON2ID_V1.timeCost,
    parallelism: ARGON2ID_V1.parallelism,
    outputLen: ARGON2ID_V1.outputLen,
  };
}

function parseExactInteger(value: string, prefix: string): number | undefined {
  if (!value.startsWith(`${prefix}=`)) return undefined;
  return parseDecimal(value.slice(prefix.length + 1));
}

function parseDecimal(value: string | undefined): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function decodeBase64Length(value: string): number | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    return atob(value.padEnd(Math.ceil(value.length / 4) * 4, "=")).length;
  } catch {
    return undefined;
  }
}
