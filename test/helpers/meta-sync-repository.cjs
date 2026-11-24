function memoryRepository() {
  const tables = { run: new Map(), chunk: new Map(), contact: new Map() };
  const comparable = (x) => (x instanceof Date || Object.prototype.toString.call(x) === '[object Date]' ? +x : x);
  function matches(row, where = {}) {
    return Object.entries(where).every(([key, expected]) => {
      if (key === 'OR') return expected.some((x) => matches(row, x));
      if (key === 'AND') return expected.every((x) => matches(row, x));
      const actual = comparable(row[key]);
      if (
        expected &&
        typeof expected === 'object' &&
        !(expected instanceof Date) &&
        Object.prototype.toString.call(expected) !== '[object Date]'
      ) {
        return Object.entries(expected).every(([op, value]) => {
          const target = comparable(value);
          if (op === 'lte') return actual <= target;
          if (op === 'lt') return actual < target;
          if (op === 'gte') return actual >= target;
          if (op === 'gt') return actual > target;
          if (op === 'not') return actual !== target;
          if (op === 'in') return value.includes(actual);
          throw new Error('Unexpected repository operator ' + op);
        });
      }
      return actual === comparable(expected);
    });
  }
  const repository = { tables };
  for (const [name, table] of Object.entries(tables)) {
    const model = {
      async findUnique({ where }) {
        return [...table.values()].find((row) => matches(row, where)) || null;
      },
      async findFirst({ where }) {
        return [...table.values()].find((row) => matches(row, where)) || null;
      },
      async findMany({ where } = {}) {
        return [...table.values()].filter((row) => matches(row, where));
      },
      async count({ where } = {}) {
        return [...table.values()].filter((row) => matches(row, where)).length;
      },
      async create({ data }) {
        if (
          table.has(data.id) ||
          (name === 'run' && [...table.values()].some((x) => x.instanceId === data.instanceId))
        ) {
          throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
        }
        const row = {
          cursor: 0,
          attempts: 0,
          leaseVersion: 0,
          duplicateCount: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          contactsRequestId: null,
          historyRequestId: null,
          blocked: null,
          sourceProgress: 0,
          historyConsent: 'unknown',
          ...data,
        };
        table.set(data.id, row);
        return row;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of table.values())
          if (matches(row, where)) {
            for (const [key, value] of Object.entries(data))
              row[key] =
                value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
            count++;
          }
        return { count };
      },
    };
    repository[{ run: 'businessAppSyncRun', chunk: 'businessAppSyncChunk', contact: 'businessAppContact' }[name]] =
      model;
  }
  return repository;
}

module.exports = { memoryRepository };
