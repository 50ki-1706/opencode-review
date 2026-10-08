// src/main.ts
import { appendFile, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { pathToFileURL } from "node:url";

// node_modules/.pnpm/valibot@1.5.0_typescript@7.0.2/node_modules/valibot/dist/index.mjs
var store$4;
var DEFAULT_CONFIG = {
  lang: void 0,
  message: void 0,
  abortEarly: void 0,
  abortPipeEarly: void 0
};
// @__NO_SIDE_EFFECTS__
function getGlobalConfig(config$1) {
  if (!config$1 && !store$4) return DEFAULT_CONFIG;
  return {
    lang: config$1?.lang ?? store$4?.lang,
    message: config$1?.message,
    abortEarly: config$1?.abortEarly ?? store$4?.abortEarly,
    abortPipeEarly: config$1?.abortPipeEarly ?? store$4?.abortPipeEarly
  };
}
var store$3;
// @__NO_SIDE_EFFECTS__
function getGlobalMessage(lang) {
  return store$3?.get(lang);
}
var store$2;
// @__NO_SIDE_EFFECTS__
function getSchemaMessage(lang) {
  return store$2?.get(lang);
}
var store$1;
// @__NO_SIDE_EFFECTS__
function getSpecificMessage(reference, lang) {
  return store$1?.get(reference)?.get(lang);
}
// @__NO_SIDE_EFFECTS__
function _stringify(input) {
  const type = typeof input;
  if (type === "string") return `"${input}"`;
  if (type === "number" || type === "bigint" || type === "boolean") return `${input}`;
  if (type === "object" || type === "function") return (input && Object.getPrototypeOf(input)?.constructor?.name) ?? "null";
  return type;
}
function _addIssue(context, label, dataset, config$1, other) {
  const input = other && "input" in other ? other.input : dataset.value;
  const expected = other?.expected ?? context.expects ?? null;
  const received = other?.received ?? /* @__PURE__ */ _stringify(input);
  const issue = {
    kind: context.kind,
    type: context.type,
    input,
    expected,
    received,
    message: `Invalid ${label}: ${expected ? `Expected ${expected} but r` : "R"}eceived ${received}`,
    requirement: context.requirement,
    path: other?.path,
    issues: other?.issues,
    lang: config$1.lang,
    abortEarly: config$1.abortEarly,
    abortPipeEarly: config$1.abortPipeEarly
  };
  const isSchema = context.kind === "schema";
  const message$1 = other?.message ?? context.message ?? /* @__PURE__ */ getSpecificMessage(context.reference, issue.lang) ?? (isSchema ? /* @__PURE__ */ getSchemaMessage(issue.lang) : null) ?? config$1.message ?? /* @__PURE__ */ getGlobalMessage(issue.lang);
  if (message$1 !== void 0) issue.message = typeof message$1 === "function" ? message$1(issue) : message$1;
  if (isSchema) dataset.typed = false;
  if (dataset.issues) dataset.issues.push(issue);
  else dataset.issues = [issue];
}
// @__NO_SIDE_EFFECTS__
function _isSameValueZero(value1, value2) {
  return value1 === value2 || Number.isNaN(value1) && Number.isNaN(value2);
}
// @__NO_SIDE_EFFECTS__
function _joinExpects(values$1, separator) {
  const list = [...new Set(values$1)];
  if (list.length > 1) return `(${list.join(` ${separator} `)})`;
  return list[0] ?? "never";
}
function _standardSchema(schema) {
  schema["~standard"] = {
    version: 1,
    vendor: "valibot",
    validate: (value$1) => schema["~run"]({ value: value$1 }, /* @__PURE__ */ getGlobalConfig())
  };
  return schema;
}
var EMOJI_REGEX = new RegExp("^(?:[\\u{1F1E6}-\\u{1F1FF}]{2}|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]{2}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,3}\\u{E007F}|(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|(?![\\p{Emoji_Modifier_Base}\\u{1F1E6}-\\u{1F1FF}])\\p{Emoji_Presentation})(?:\\u200D(?:\\p{Emoji}\\uFE0F\\u20E3?|\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}?|(?![\\p{Emoji_Modifier_Base}\\u{1F1E6}-\\u{1F1FF}])\\p{Emoji_Presentation}))*)+$", "u");
// @__NO_SIDE_EFFECTS__
function check(requirement, message$1) {
  return {
    kind: "validation",
    type: "check",
    reference: check,
    async: false,
    expects: null,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "input", dataset, config$1);
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function finite(message$1) {
  return {
    kind: "validation",
    type: "finite",
    reference: finite,
    async: false,
    expects: null,
    requirement: Number.isFinite,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "finite", dataset, config$1);
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function integer(message$1) {
  return {
    kind: "validation",
    type: "integer",
    reference: integer,
    async: false,
    expects: null,
    requirement: Number.isInteger,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "integer", dataset, config$1);
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function maxLength(requirement, message$1) {
  return {
    kind: "validation",
    type: "max_length",
    reference: maxLength,
    async: false,
    expects: `<=${requirement}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && dataset.value.length > this.requirement) _addIssue(this, "length", dataset, config$1, { received: `${dataset.value.length}` });
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function maxValue(requirement, message$1) {
  return {
    kind: "validation",
    type: "max_value",
    reference: maxValue,
    async: false,
    expects: `<=${requirement instanceof Date ? requirement.toJSON() : /* @__PURE__ */ _stringify(requirement)}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !(dataset.value <= this.requirement)) _addIssue(this, "value", dataset, config$1, { received: dataset.value instanceof Date ? dataset.value.toJSON() : /* @__PURE__ */ _stringify(dataset.value) });
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function minLength(requirement, message$1) {
  return {
    kind: "validation",
    type: "min_length",
    reference: minLength,
    async: false,
    expects: `>=${requirement}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && dataset.value.length < this.requirement) _addIssue(this, "length", dataset, config$1, { received: `${dataset.value.length}` });
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function minValue(requirement, message$1) {
  return {
    kind: "validation",
    type: "min_value",
    reference: minValue,
    async: false,
    expects: `>=${requirement instanceof Date ? requirement.toJSON() : /* @__PURE__ */ _stringify(requirement)}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !(dataset.value >= this.requirement)) _addIssue(this, "value", dataset, config$1, { received: dataset.value instanceof Date ? dataset.value.toJSON() : /* @__PURE__ */ _stringify(dataset.value) });
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function regex(requirement, message$1) {
  return {
    kind: "validation",
    type: "regex",
    reference: regex,
    async: false,
    expects: `${requirement}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !this.requirement.test(dataset.value)) _addIssue(this, "format", dataset, config$1);
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function transform(operation) {
  return {
    kind: "transformation",
    type: "transform",
    reference: transform,
    async: false,
    operation,
    "~run"(dataset) {
      dataset.value = this.operation(dataset.value);
      return dataset;
    }
  };
}
// @__NO_SIDE_EFFECTS__
function trim() {
  return {
    kind: "transformation",
    type: "trim",
    reference: trim,
    async: false,
    "~run"(dataset) {
      dataset.value = dataset.value.trim();
      return dataset;
    }
  };
}
var ABORT_EARLY_CONFIG = { abortEarly: true };
// @__NO_SIDE_EFFECTS__
function getFallback(schema, dataset, config$1) {
  return typeof schema.fallback === "function" ? schema.fallback(dataset, config$1) : schema.fallback;
}
// @__NO_SIDE_EFFECTS__
function getDefault(schema, dataset, config$1) {
  return typeof schema.default === "function" ? schema.default(dataset, config$1) : schema.default;
}
// @__NO_SIDE_EFFECTS__
function array(item, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "array",
    reference: array,
    expects: "Array",
    async: false,
    item,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (Array.isArray(input)) {
        dataset.typed = true;
        dataset.value = [];
        for (let key = 0; key < input.length; key++) {
          const value$1 = input[key];
          const itemDataset = this.item["~run"]({ value: value$1 }, config$1);
          if (itemDataset.issues) {
            const pathItem = {
              type: "array",
              origin: "value",
              input,
              key,
              value: value$1
            };
            for (const issue of itemDataset.issues) {
              if (issue.path) issue.path.unshift(pathItem);
              else issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = itemDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          if (!itemDataset.typed) dataset.typed = false;
          dataset.value.push(itemDataset.value);
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function boolean(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "boolean",
    reference: boolean,
    expects: "boolean",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "boolean") dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function literal(literal_, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "literal",
    reference: literal,
    expects: /* @__PURE__ */ _stringify(literal_),
    async: false,
    literal: literal_,
    message: message$1,
    "~run"(dataset, config$1) {
      if (/* @__PURE__ */ _isSameValueZero(dataset.value, this.literal)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function number(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "number",
    reference: number,
    expects: "number",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "number" && !isNaN(dataset.value)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function object(entries$1, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "object",
    reference: object,
    expects: "Object",
    async: false,
    entries: entries$1,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        dataset.typed = true;
        dataset.value = {};
        for (const key in this.entries) {
          const valueSchema = this.entries[key];
          if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
            const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
            const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
            if (valueDataset.issues) {
              const pathItem = {
                type: "object",
                origin: "value",
                input,
                key,
                value: value$1
              };
              for (const issue of valueDataset.issues) {
                if (issue.path) issue.path.unshift(pathItem);
                else issue.path = [pathItem];
                dataset.issues?.push(issue);
              }
              if (!dataset.issues) dataset.issues = valueDataset.issues;
              if (config$1.abortEarly) {
                dataset.typed = false;
                break;
              }
            }
            if (!valueDataset.typed) dataset.typed = false;
            dataset.value[key] = valueDataset.value;
          } else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
          else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
            _addIssue(this, "key", dataset, config$1, {
              input: void 0,
              expected: `"${key}"`,
              path: [{
                type: "object",
                origin: "key",
                input,
                key,
                value: input[key]
              }]
            });
            if (config$1.abortEarly) break;
          }
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function optional(wrapped, default_) {
  return _standardSchema({
    kind: "schema",
    type: "optional",
    reference: optional,
    expects: `(${wrapped.expects} | undefined)`,
    async: false,
    wrapped,
    default: default_,
    "~run"(dataset, config$1) {
      if (dataset.value === void 0) {
        if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
        if (dataset.value === void 0) {
          dataset.typed = true;
          return dataset;
        }
      }
      return this.wrapped["~run"](dataset, config$1);
    }
  });
}
// @__NO_SIDE_EFFECTS__
function picklist(options, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "picklist",
    reference: picklist,
    expects: /* @__PURE__ */ _joinExpects(options.map(_stringify), "|"),
    async: false,
    options,
    message: message$1,
    "~run"(dataset, config$1) {
      if (this.options.includes(dataset.value)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function strictObject(entries$1, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "strict_object",
    reference: strictObject,
    expects: "Object",
    async: false,
    entries: entries$1,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        dataset.typed = true;
        dataset.value = {};
        for (const key in this.entries) {
          const valueSchema = this.entries[key];
          if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
            const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
            const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
            if (valueDataset.issues) {
              const pathItem = {
                type: "object",
                origin: "value",
                input,
                key,
                value: value$1
              };
              for (const issue of valueDataset.issues) {
                if (issue.path) issue.path.unshift(pathItem);
                else issue.path = [pathItem];
                dataset.issues?.push(issue);
              }
              if (!dataset.issues) dataset.issues = valueDataset.issues;
              if (config$1.abortEarly) {
                dataset.typed = false;
                break;
              }
            }
            if (!valueDataset.typed) dataset.typed = false;
            dataset.value[key] = valueDataset.value;
          } else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
          else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
            _addIssue(this, "key", dataset, config$1, {
              input: void 0,
              expected: `"${key}"`,
              path: [{
                type: "object",
                origin: "key",
                input,
                key,
                value: input[key]
              }]
            });
            if (config$1.abortEarly) break;
          }
        }
        if (!dataset.issues || !config$1.abortEarly) {
          for (const key in input) if (!Object.prototype.hasOwnProperty.call(this.entries, key)) {
            _addIssue(this, "key", dataset, config$1, {
              input: key,
              expected: "never",
              path: [{
                type: "object",
                origin: "key",
                input,
                key,
                value: input[key]
              }]
            });
            break;
          }
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function string(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "string",
    reference: string,
    expects: "string",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "string") dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function _subIssues(datasets) {
  let issues;
  if (datasets) for (const dataset of datasets) if (issues) for (const issue of dataset.issues) issues.push(issue);
  else issues = dataset.issues;
  return issues;
}
// @__NO_SIDE_EFFECTS__
function union(options, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "union",
    reference: union,
    expects: /* @__PURE__ */ _joinExpects(options.map((option) => option.expects), "|"),
    async: false,
    options,
    message: message$1,
    "~run"(dataset, config$1) {
      let validDataset;
      let typedDatasets;
      let untypedDatasets;
      for (const schema of this.options) {
        const optionDataset = schema["~run"]({ value: dataset.value }, config$1);
        if (optionDataset.typed) if (optionDataset.issues) if (typedDatasets) typedDatasets.push(optionDataset);
        else typedDatasets = [optionDataset];
        else {
          validDataset = optionDataset;
          break;
        }
        else if (untypedDatasets) untypedDatasets.push(optionDataset);
        else untypedDatasets = [optionDataset];
      }
      if (validDataset) return validDataset;
      if (typedDatasets) {
        if (typedDatasets.length === 1) return typedDatasets[0];
        _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(typedDatasets) });
        dataset.typed = true;
      } else if (untypedDatasets?.length === 1) return untypedDatasets[0];
      else _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(untypedDatasets) });
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function unknown() {
  return _standardSchema({
    kind: "schema",
    type: "unknown",
    reference: unknown,
    expects: "unknown",
    async: false,
    "~run"(dataset) {
      dataset.typed = true;
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function variant(key, options, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "variant",
    reference: variant,
    expects: "Object",
    async: false,
    key,
    options,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        let outputDataset;
        let maxDiscriminatorPriority = 0;
        let invalidDiscriminatorKey = this.key;
        let expectedDiscriminators = [];
        const parseOptions = (variant$1, allKeys) => {
          for (const schema of variant$1.options) {
            if (schema.type === "variant") parseOptions(schema, new Set(allKeys).add(schema.key));
            else {
              let keysAreValid = true;
              let currentPriority = 0;
              for (const currentKey of allKeys) {
                const discriminatorSchema = schema.entries[currentKey];
                if (currentKey in input ? discriminatorSchema["~run"]({
                  typed: false,
                  value: input[currentKey]
                }, ABORT_EARLY_CONFIG).issues : discriminatorSchema.type !== "exact_optional" && discriminatorSchema.type !== "optional" && discriminatorSchema.type !== "nullish") {
                  keysAreValid = false;
                  if (invalidDiscriminatorKey !== currentKey && (maxDiscriminatorPriority < currentPriority || maxDiscriminatorPriority === currentPriority && currentKey in input && !(invalidDiscriminatorKey in input))) {
                    maxDiscriminatorPriority = currentPriority;
                    invalidDiscriminatorKey = currentKey;
                    expectedDiscriminators = [];
                  }
                  if (invalidDiscriminatorKey === currentKey) expectedDiscriminators.push(schema.entries[currentKey].expects);
                  break;
                }
                currentPriority++;
              }
              if (keysAreValid) {
                const optionDataset = schema["~run"]({ value: input }, config$1);
                if (!outputDataset || !outputDataset.typed && optionDataset.typed) outputDataset = optionDataset;
              }
            }
            if (outputDataset && !outputDataset.issues) break;
          }
        };
        parseOptions(this, /* @__PURE__ */ new Set([this.key]));
        if (outputDataset) return outputDataset;
        _addIssue(this, "type", dataset, config$1, {
          input: input[invalidDiscriminatorKey],
          expected: /* @__PURE__ */ _joinExpects(expectedDiscriminators, "|"),
          path: [{
            type: "object",
            origin: "value",
            input,
            key: invalidDiscriminatorKey,
            value: input[invalidDiscriminatorKey]
          }]
        });
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function pipe(...pipe$1) {
  return _standardSchema({
    ...pipe$1[0],
    pipe: pipe$1,
    "~run"(dataset, config$1) {
      for (const item of pipe$1) if (item.kind !== "metadata") {
        if (dataset.issues && (item.kind === "schema" || item.kind === "transformation")) {
          dataset.typed = false;
          break;
        }
        if (!dataset.issues || !config$1.abortEarly && !config$1.abortPipeEarly) dataset = item["~run"](dataset, config$1);
      }
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function safeParse(schema, input, config$1) {
  const dataset = schema["~run"]({ value: input }, /* @__PURE__ */ getGlobalConfig(config$1));
  return {
    typed: dataset.typed,
    success: !dataset.issues,
    output: dataset.value,
    issues: dataset.issues
  };
}

// src/finding.ts
var severitySchema = picklist(["critical", "high", "medium", "low"]);
var rangeQualitySchema = picklist(["correct", "too_narrow", "too_wide", "wrong_location"]);
var lineNumberSchema = pipe(number(), finite(), integer(), minValue(1));
var probabilitySchema = pipe(number(), finite(), minValue(0), maxValue(1));
var nonEmptyStringSchema = pipe(string(), minLength(1));
var commitIdSchema = pipe(string(), regex(/^[0-9a-f]{40}$/i));
var boundedNonBlankStringSchema = (maxLength2) => pipe(
  string(),
  check((value) => value.trim().length > 0, "must not be blank"),
  maxLength(maxLength2)
);
var reportFindingInputSchema = pipe(
  strictObject({
    path: boundedNonBlankStringSchema(512),
    candidateStart: lineNumberSchema,
    candidateEnd: lineNumberSchema,
    anchor: boundedNonBlankStringSchema(5e3),
    severity: severitySchema,
    title: boundedNonBlankStringSchema(200),
    body: boundedNonBlankStringSchema(2e4)
  }),
  check((input) => input.candidateStart <= input.candidateEnd, "candidateStart must be <= candidateEnd")
);
var toolReceiptSchema = variant("queued", [
  strictObject({ queued: literal(true) }),
  strictObject({ queued: literal(false), reason: nonEmptyStringSchema })
]);
var candidateRangeSchema = strictObject({
  start: lineNumberSchema,
  end: lineNumberSchema,
  anchor: nonEmptyStringSchema
});
var findingSchema = strictObject({
  id: nonEmptyStringSchema,
  skill: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  candidateRange: candidateRangeSchema,
  severity: severitySchema,
  title: nonEmptyStringSchema,
  body: nonEmptyStringSchema
});
var resolvedRangeSchema = strictObject({
  path: nonEmptyStringSchema,
  commitId: commitIdSchema,
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
  /** Anchor window start inside the resolved range (Q07 corrections need it). */
  anchorStartLine: lineNumberSchema,
  side: literal("RIGHT"),
  code: string()
});
var validationResultSchema = strictObject({
  supported: probabilitySchema,
  commentWorthy: probabilitySchema,
  rangeQuality: rangeQualitySchema
});
var publishableFindingSchema = strictObject({
  id: nonEmptyStringSchema,
  skill: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  commitId: commitIdSchema,
  startLine: lineNumberSchema,
  endLine: lineNumberSchema,
  side: literal("RIGHT"),
  severity: severitySchema,
  title: nonEmptyStringSchema,
  body: nonEmptyStringSchema
});
function publishableGate(input, thresholds) {
  return input.deterministicRangeChecksPassed && input.validation.supported >= thresholds.supported && input.validation.commentWorthy >= thresholds.commentWorthy && input.validation.rangeQuality === "correct";
}
function toPublishableFinding(finding, resolved) {
  return {
    id: finding.id,
    skill: finding.skill,
    path: resolved.path,
    commitId: resolved.commitId,
    startLine: resolved.startLine,
    endLine: resolved.endLine,
    side: resolved.side,
    severity: finding.severity,
    title: finding.title,
    body: finding.body
  };
}
var gateSkipMessages = {
  evidence_overflow: "state\u304C\u4E0A\u9650\uFF0824000 UTF-16 code units\uFF09\u3092\u8D85\u3048\u308B\u305F\u3081Jev\u691C\u8A3C\u3092\u7701\u7565\u3057\u307E\u3057\u305F\u3002",
  below_supported: "Jev\u306Esupported\u304C\u3057\u304D\u3044\u5024\u672A\u6E80\u306E\u305F\u3081\u6295\u7A3F\u3057\u307E\u305B\u3093\u3002",
  below_comment_worthy: "Jev\u306EcommentWorthy\u304C\u3057\u304D\u3044\u5024\u672A\u6E80\u306E\u305F\u3081\u6295\u7A3F\u3057\u307E\u305B\u3093\u3002",
  range_quality_wrong_location: "Jev\u304C\u7BC4\u56F2\u3092wrong_location\u3068\u5224\u5B9A\u3057\u305F\u305F\u3081\u6295\u7A3F\u3057\u307E\u305B\u3093\u3002",
  range_retry_exhausted: "\u7BC4\u56F2\u306E\u518D\u89E3\u6C7A\u30FB\u518D\u8A55\u4FA1\u3092\u884C\u3044\u307E\u3057\u305F\u304C\u5408\u683C\u3057\u306A\u304B\u3063\u305F\u305F\u3081\u6295\u7A3F\u3057\u307E\u305B\u3093\u3002"
};
function decideGate(input) {
  const { finding, resolved, validation, thresholds, rangeRetryUsed } = input;
  if (publishableGate({ finding, resolved, validation, deterministicRangeChecksPassed: true }, thresholds)) {
    return { kind: "publishable", publishable: toPublishableFinding(finding, resolved) };
  }
  const skip = (reason) => ({
    kind: "skip",
    reason,
    message: gateSkipMessages[reason]
  });
  if (validation.supported < thresholds.supported) {
    return skip("below_supported");
  }
  if (validation.commentWorthy < thresholds.commentWorthy) {
    return skip("below_comment_worthy");
  }
  if (validation.rangeQuality === "wrong_location") {
    return skip("range_quality_wrong_location");
  }
  if (validation.rangeQuality !== "too_narrow" && validation.rangeQuality !== "too_wide") {
    return skip("range_retry_exhausted");
  }
  if (rangeRetryUsed) {
    return skip("range_retry_exhausted");
  }
  return { kind: "retry_range", quality: validation.rangeQuality };
}
var jevRequestModelSchema = picklist(["jev-1.13-free", "jev-1.13"]);
var noulAnswerSchema = strictObject({
  type: literal("noul"),
  noul: probabilitySchema
});
var choiceAnswerSchema = object({
  type: literal("choice"),
  choice: rangeQualitySchema,
  probabilities: optional(
    strictObject({
      correct: probabilitySchema,
      too_narrow: probabilitySchema,
      too_wide: probabilitySchema,
      wrong_location: probabilitySchema
    })
  ),
  confidence: optional(probabilitySchema)
});
var jevResponseSchema = strictObject({
  model: nonEmptyStringSchema,
  answers: strictObject({
    supported: noulAnswerSchema,
    commentWorthy: noulAnswerSchema,
    rangeQuality: choiceAnswerSchema
  }),
  usage: optional(
    object({
      input_tokens: pipe(number(), finite(), integer(), minValue(0)),
      output_tokens: pipe(number(), finite(), integer(), minValue(0))
    })
  ),
  cost: optional(union([string(), number()]))
});
function validationResultFromJev(response) {
  return {
    supported: response.answers.supported.noul,
    commentWorthy: response.answers.commentWorthy.noul,
    rangeQuality: response.answers.rangeQuality.choice
  };
}
var MAX_SKILL_CRITERIA_CODE_UNITS = 8e3;
function skillCriteriaExcerpt(body) {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_SKILL_CRITERIA_CODE_UNITS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SKILL_CRITERIA_CODE_UNITS)}
[skill criteria truncated]`;
}
var jevQuestions = {
  supported: {
    type: "noul",
    instructions: "Does the presented HEAD code and evidence in `range` and `evidence` support the claim in `finding`?",
    criteria: {
      true: "The quoted code shows the claimed behavior without further inference.",
      false: "The quoted code contradicts the claim, or the claim needs code that is not presented."
    }
  },
  commentWorthy: {
    type: "noul",
    instructions: "According to `skill.criteria`, does `finding` describe a concrete harm that warrants an inline review comment?",
    criteria: {
      true: "A concrete defect or harm with a real trigger and impact.",
      false: "A style preference, speculation, or harmlessness."
    }
  },
  rangeQuality: {
    type: "choice",
    instructions: "Does `range` contain exactly the code lines needed to support `finding`?",
    criteria: {
      correct: null,
      too_narrow: "The range omits lines the finding depends on.",
      too_wide: "The range includes unrelated lines beyond what the finding needs.",
      wrong_location: "The range points at code unrelated to the finding."
    }
  }
};
function codeLines(code) {
  if (code.length === 0) {
    return [];
  }
  const lines = code.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
function buildJevState(input) {
  return {
    skill: { name: input.skillCriteria.name, criteria: input.skillCriteria.criteria },
    finding: {
      path: input.finding.path,
      severity: input.finding.severity,
      title: input.finding.title,
      body: input.finding.body
    },
    range: {
      commitId: input.resolved.commitId,
      path: input.resolved.path,
      startLine: input.resolved.startLine,
      endLine: input.resolved.endLine,
      side: input.resolved.side,
      code: codeLines(input.resolved.code)
    },
    evidence: input.evidence
  };
}
function jevRequestBody(input) {
  return {
    model: input.model,
    state: buildJevState(input),
    questions: jevQuestions
  };
}
var JEV_STATE_LIMIT_CODE_UNITS = 24e3;
function jevStateSize(state) {
  return JSON.stringify(state).length;
}
var evidenceLadder = [
  { contextBefore: Number.POSITIVE_INFINITY, contextAfter: Number.POSITIVE_INFINITY, diffHunks: Number.POSITIVE_INFINITY },
  { contextBefore: 5, contextAfter: 5, diffHunks: Number.POSITIVE_INFINITY },
  { contextBefore: 3, contextAfter: 3, diffHunks: 24 },
  { contextBefore: 0, contextAfter: 0, diffHunks: 12 },
  { contextBefore: 0, contextAfter: 0, diffHunks: 0 }
];
function degradeJevState(state, level) {
  const limits = evidenceLadder[level];
  const contextBefore = limits.contextBefore === Number.POSITIVE_INFINITY ? state.evidence.contextBefore : state.evidence.contextBefore.slice(-limits.contextBefore);
  const contextAfter = limits.contextAfter === Number.POSITIVE_INFINITY ? state.evidence.contextAfter : state.evidence.contextAfter.slice(0, limits.contextAfter);
  const diffHunks = limits.diffHunks === Number.POSITIVE_INFINITY ? state.evidence.diffHunks : state.evidence.diffHunks.slice(0, limits.diffHunks);
  return {
    ...state,
    evidence: {
      contextBefore,
      contextAfter,
      diffHunks,
      evidenceTruncated: state.evidence.evidenceTruncated || level > 0
    }
  };
}
function fitJevState(state) {
  const levels = [0, 1, 2, 3, 4];
  for (const level of levels) {
    const candidate = degradeJevState(state, level);
    if (jevStateSize(candidate) <= JEV_STATE_LIMIT_CODE_UNITS) {
      return { kind: "fits", state: candidate, level };
    }
  }
  return { kind: "evidence_overflow" };
}

// src/github.ts
var GITHUB_API_VERSION = "2026-03-10";
var MAX_FILE_PAGES = 50;
var shaSchema = pipe(string(), regex(/^[0-9a-f]{40}$/i));
var repoFullNameSchema = pipe(string(), regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/));
var errorBodySchema = object({
  message: optional(string()),
  documentation_url: optional(string()),
  errors: optional(array(unknown()))
});
var GitHubError = class extends Error {
  status;
  fields;
  constructor(status, message, fields = []) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.fields = fields;
  }
};
var HeadChangedError = class extends Error {
  expectedSha;
  actualSha;
  constructor(expectedSha, actualSha) {
    super(`PR head changed during context: expected ${expectedSha}, got ${actualSha}`);
    this.name = "HeadChangedError";
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
  }
};
function issuePaths(issues) {
  const paths = issues.map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join(".");
    return path && path.length > 0 ? path : "body";
  });
  return [...new Set(paths)];
}
function excerpt(text, limit = 300) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}
function parseNextLink(linkHeader, baseUrl) {
  if (!linkHeader) {
    return null;
  }
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(linkHeader);
  if (!match?.[1]) {
    return null;
  }
  const next = new URL(match[1], baseUrl);
  if (next.origin !== new URL(baseUrl).origin) {
    throw new GitHubError(0, "GitHub pagination crossed origins", ["Link"]);
  }
  return `${next.pathname}${next.search}`;
}
async function githubFetch(options) {
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  const url = new URL(options.path, baseUrl);
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "opencode-review-action"
  };
  if (options.body !== void 0) {
    headers["content-type"] = "application/json";
  }
  let response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === void 0 ? void 0 : JSON.stringify(options.body),
      redirect: "manual",
      signal: options.signal
    });
  } catch (error) {
    throw new GitHubError(0, `GitHub request failed: ${error instanceof Error ? error.name : "unknown error"}`, ["network"]);
  }
  const text = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new GitHubError(response.status, "GitHub API redirect is not followed", ["redirect"]);
  }
  let body = null;
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new GitHubError(response.status, "GitHub API returned a non-JSON body", ["body"]);
      }
      body = null;
    }
  }
  if (!response.ok) {
    const parsed = safeParse(errorBodySchema, body);
    const fields = parsed.success ? Object.keys(parsed.output).filter((key) => parsed.output[key] !== void 0) : [];
    const message = parsed.success && parsed.output.message ? excerpt(parsed.output.message) : "request failed";
    throw new GitHubError(response.status, `GitHub API error ${response.status}: ${message}`, fields);
  }
  return {
    body,
    nextPath: parseNextLink(response.headers.get("link"), baseUrl)
  };
}
var prInfoSchema = object({
  number: pipe(number(), finite(), integer(), minValue(1)),
  state: string(),
  draft: boolean(),
  head: object({
    sha: shaSchema,
    ref: string(),
    repo: object({ full_name: string() })
  }),
  base: object({ sha: shaSchema })
});
var changedFileSchema = object({
  filename: string(),
  status: string(),
  previous_filename: optional(string())
});
function reposPath(repoFullName, suffix) {
  if (!safeParse(repoFullNameSchema, repoFullName).success) {
    throw new GitHubError(0, "invalid repository name", ["repository"]);
  }
  const [owner, repo] = repoFullName.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}
async function getPullRequest(token, repoFullName, number2, options = {}) {
  const result = await githubFetch({ token, path: reposPath(repoFullName, `/pulls/${number2}`), ...options });
  const parsed = safeParse(prInfoSchema, result.body);
  if (!parsed.success) {
    throw new GitHubError(200, "unexpected pull request response shape", issuePaths(parsed.issues));
  }
  return parsed.output;
}
async function listChangedFiles(token, repoFullName, number2, options = {}) {
  const files = [];
  let path = reposPath(repoFullName, `/pulls/${number2}/files?per_page=100`);
  let pages = 0;
  while (path !== null) {
    if (pages >= MAX_FILE_PAGES) {
      throw new GitHubError(0, `changed files pagination exceeded ${MAX_FILE_PAGES} pages`, ["pagination"]);
    }
    pages += 1;
    const result = await githubFetch({ token, path, ...options });
    const parsed = safeParse(array(changedFileSchema), result.body);
    if (!parsed.success) {
      throw new GitHubError(200, "unexpected changed files response shape", issuePaths(parsed.issues));
    }
    files.push(...parsed.output);
    path = result.nextPath;
  }
  return files;
}
async function verifyHeadCurrent(token, repoFullName, number2, expectedSha, options = {}) {
  const live = await getPullRequest(token, repoFullName, number2, options);
  if (live.head.sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new HeadChangedError(expectedSha.toLowerCase(), live.head.sha.toLowerCase());
  }
  return live;
}
var inlineCommentPayloadSchema = strictObject({
  commit_id: shaSchema,
  path: pipe(string(), minLength(1)),
  start_line: optional(pipe(number(), finite(), integer(), minValue(1))),
  start_side: optional(literal("RIGHT")),
  line: pipe(number(), finite(), integer(), minValue(1)),
  side: literal("RIGHT"),
  body: pipe(string(), minLength(1))
});
function buildInlinePayload(finding) {
  const multiLine = finding.startLine !== finding.endLine;
  return {
    commit_id: finding.commitId.toLowerCase(),
    path: finding.path,
    ...multiLine ? { start_line: finding.startLine, start_side: "RIGHT" } : {},
    line: finding.endLine,
    side: "RIGHT",
    body: `[${finding.severity}] ${finding.title}

${finding.body}`
  };
}
var postedCommentSchema = object({
  id: pipe(number(), finite(), integer(), minValue(1)),
  url: pipe(string(), minLength(1))
});
async function postInlineComment(token, repoFullName, number2, payload, options = {}) {
  const result = await githubFetch({
    token,
    path: reposPath(repoFullName, `/pulls/${number2}/comments`),
    method: "POST",
    body: payload,
    ...options
  });
  const parsed = safeParse(postedCommentSchema, result.body);
  if (!parsed.success) {
    throw new GitHubError(201, "unexpected inline comment response shape", issuePaths(parsed.issues));
  }
  return parsed.output;
}

// src/jev.ts
var JEV_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
var JEV_MAX_ATTEMPTS = 3;
var JEV_ATTEMPT_TIMEOUT_MS = 6e4;
var JEV_RETRY_BASE_MS = 1e3;
var JEV_RETRY_MAX_WAIT_MS = 3e4;
var JevRunError = class extends Error {
  kind;
  fields;
  constructor(kind, message, fields = ["jev"]) {
    super(message);
    this.name = "JevRunError";
    this.kind = kind;
    this.fields = fields;
  }
};
function excerpt2(text, limit = 120) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}
function errorName(error) {
  return error instanceof Error && error.name.length > 0 ? error.name : "unknown error";
}
function isTimeoutError(error) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
var jevErrorBodySchema = object({
  error: object({
    type: string(),
    message: optional(string()),
    param: optional(string())
  })
});
function parseErrorBody(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = safeParse(jevErrorBodySchema, json);
  if (!parsed.success) {
    return null;
  }
  return { type: parsed.output.error.type, param: parsed.output.error.param ?? null };
}
function classify422(text) {
  const parsed = parseErrorBody(text);
  if (parsed === null) {
    return { kind: "provider", detail: "unclassified 422 body" };
  }
  if (parsed.type === "invalid_request_error" || parsed.param !== null) {
    return { kind: "request_invalid", detail: `invalid_request_error${parsed.param === null ? "" : ` (${excerpt2(parsed.param)})`}` };
  }
  return { kind: "provider", detail: excerpt2(parsed.type) };
}
function retryAfterMs(header) {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const seconds = Number.parseInt(trimmed, 10);
  return seconds * 1e3;
}
function backoffMs(attempt) {
  return Math.min(JEV_RETRY_BASE_MS * 2 ** (attempt - 1), JEV_RETRY_MAX_WAIT_MS);
}
function parseResponse(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JevRunError("response_invalid", "Jev response is not valid JSON", ["jev", "body"]);
  }
  const parsed = safeParse(jevResponseSchema, json);
  if (!parsed.success) {
    const paths = [
      ...new Set(
        parsed.issues.map((issue) => {
          const path = issue.path?.map((item) => String(item.key)).join(".");
          return path && path.length > 0 ? path : "body";
        })
      )
    ].slice(0, 5);
    throw new JevRunError(
      "response_invalid",
      `Jev response does not match the expected schema (${paths.join(", ")})`,
      paths
    );
  }
  return parsed.output;
}
function retryOrThrow(attempt, kind, detail, fields) {
  if (attempt >= JEV_MAX_ATTEMPTS) {
    throw new JevRunError(kind, `Jev ${detail} after ${JEV_MAX_ATTEMPTS} attempts`, fields);
  }
  return { kind: "retry", waitMs: backoffMs(attempt) };
}
async function attemptRequest(request, send, attempt) {
  let response;
  try {
    const timeoutSignal = AbortSignal.timeout(JEV_ATTEMPT_TIMEOUT_MS);
    const signal = send.signal ? AbortSignal.any([send.signal, timeoutSignal]) : timeoutSignal;
    response = await send.fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${send.token}`
      },
      body: JSON.stringify(request),
      redirect: "manual",
      signal
    });
  } catch (error) {
    if (send.signal?.aborted) {
      throw new JevRunError("network", "Jev request was aborted", ["jev", "aborted"]);
    }
    const kind = isTimeoutError(error) ? "timeout" : "network";
    return retryOrThrow(attempt, kind, `request failed (${errorName(error)})`, ["jev", kind]);
  }
  const status = response.status;
  if (status >= 300 && status < 400) {
    throw new JevRunError("redirect", "Jev endpoint returned a redirect; refusing to follow", ["jev", "redirect"]);
  }
  if (status >= 200 && status < 300) {
    try {
      return { kind: "response", text: await response.text() };
    } catch (error) {
      return retryOrThrow(attempt, "network", `response body could not be read (${errorName(error)})`, ["jev", "network"]);
    }
  }
  const text = await response.text().catch(() => "");
  if (status === 401 || status === 403) {
    const parsed = parseErrorBody(text);
    const type = parsed === null ? "" : ` ${excerpt2(parsed.type, 64)}`;
    throw new JevRunError("auth", `Jev authentication failed (${status}${type})`, ["jev", "auth"]);
  }
  if (status === 422) {
    const classified = classify422(text);
    throw new JevRunError(
      classified.kind,
      `Jev rejected the request (422 ${classified.detail})`,
      ["jev", classified.kind === "provider" ? "provider" : "request"]
    );
  }
  if (status === 429 || status >= 500) {
    const wait = retryAfterMs(response.headers.get("retry-after"));
    const kind = status === 429 ? "rate_limit" : "provider";
    if (wait !== null && wait > JEV_RETRY_MAX_WAIT_MS) {
      throw new JevRunError(
        kind,
        `Jev asked to retry after ${Math.ceil(wait / 1e3)}s, above the ${JEV_RETRY_MAX_WAIT_MS / 1e3}s cap`,
        ["jev", "retry-after"]
      );
    }
    if (attempt >= JEV_MAX_ATTEMPTS) {
      throw new JevRunError(kind, `Jev API error ${status} after ${JEV_MAX_ATTEMPTS} attempts`, ["jev", kind]);
    }
    return { kind: "retry", waitMs: wait ?? backoffMs(attempt) };
  }
  throw new JevRunError("status", `Jev API error ${status}`, ["jev", "status"]);
}
async function sendRequest(request, send) {
  for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
    const result = await attemptRequest(request, send, attempt);
    if (result.kind === "response") {
      return parseResponse(result.text);
    }
    await send.sleep(result.waitMs);
  }
  throw new JevRunError("network", "Jev retry loop ended without a response", ["jev"]);
}
function createJevClient(options) {
  const send = {
    token: options.token,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };
  return {
    model: options.model,
    async validateFinding(input) {
      const state = buildJevState({
        finding: input.finding,
        resolved: input.resolved,
        skillCriteria: input.skillCriteria,
        evidence: input.evidence
      });
      const fitted = fitJevState(state);
      if (fitted.kind === "evidence_overflow") {
        return {
          kind: "evidence_overflow",
          message: `Jev state exceeds ${JEV_STATE_LIMIT_CODE_UNITS} UTF-16 code units after evidence degradation (${jevStateSize(state)})`
        };
      }
      const request = jevRequestBody({
        model: options.model,
        finding: input.finding,
        resolved: input.resolved,
        skillCriteria: input.skillCriteria,
        evidence: fitted.state.evidence
      });
      const response = await sendRequest(request, { ...send, signal: input.signal });
      return {
        kind: "validated",
        validation: validationResultFromJev(response),
        stateLevel: fitted.level,
        model: response.model
      };
    }
  };
}

// src/opencode.ts
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

// src/templates.ts
import { readFileSync } from "node:fs";

// templates/report-finding.plugin.ts
var report_finding_plugin_default = '// @ts-nocheck -- This file is an OpenCode v2 plugin TEXT ASSET, not part of the\n// TypeScript program. It is excluded from `tsconfig.json` and loaded by esbuild\n// through the ".plugin.ts": "text" loader; only src/templates.ts imports it, and\n// the Action writes the raw string into the OpenCode temp config at runtime.\n//\n// Contract shape: `export default { id, setup }` with no static imports\n// (docs/decisions.md D06/D07, measured with @opencode/cli@2.0.22). Tool gating\n// stays on the agent permissions entry for `report_finding`; do NOT set\n// `options.permission` here.\n//\n// Environment contract (set by the Action when spawning OpenCode; the template\n// only reads these names, it never chooses paths from model input):\n//   REVIEW_NDJSON_PATH          File pre-created by the Action; one JSON line per record.\n//   REVIEW_CHANGED_PATHS        JSON array of repo-relative changed paths for this PR.\n//   REVIEW_RECORD_LIMIT_BYTES   Per-record byte limit (default 32768).\n//   REVIEW_MAX_FINDINGS         Accepted-record limit for this invocation (default 100).\nconst SEVERITIES = ["critical", "high", "medium", "low"];\nconst DEFAULT_MAX_RECORD_BYTES = 32 * 1024;\nconst DEFAULT_MAX_FINDINGS = 100;\n\nfunction positiveIntegerEnv(name, fallback) {\n  const value = Number.parseInt(process.env[name] ?? "", 10);\n  return Number.isInteger(value) && value > 0 ? value : fallback;\n}\n\nconst REPORT_FINDING_SCHEMA = {\n  type: "object",\n  additionalProperties: false,\n  required: ["path", "candidateStart", "candidateEnd", "anchor", "severity", "title", "body"],\n  properties: {\n    path: { type: "string", minLength: 1 },\n    candidateStart: { type: "integer", minimum: 1 },\n    candidateEnd: { type: "integer", minimum: 1 },\n    anchor: { type: "string", minLength: 1 },\n    severity: { type: "string", enum: SEVERITIES },\n    title: { type: "string", minLength: 1 },\n    body: { type: "string", minLength: 1 },\n  },\n};\n\nfunction rejectionFor(input, allowedPaths) {\n  if (typeof input !== "object" || input === null || Array.isArray(input)) {\n    return "input must be an object";\n  }\n  if (typeof input.path !== "string" || input.path.trim().length === 0) {\n    return "path must be a non-empty string";\n  }\n  if (!allowedPaths.has(input.path)) {\n    return "path is not a changed file in this invocation";\n  }\n  if (!Number.isInteger(input.candidateStart) || !Number.isInteger(input.candidateEnd)\n      || input.candidateStart < 1 || input.candidateEnd < 1) {\n    return "candidateStart and candidateEnd must be positive integers";\n  }\n  if (input.candidateStart > input.candidateEnd) {\n    return "candidateStart must be <= candidateEnd";\n  }\n  if (!SEVERITIES.includes(input.severity)) {\n    return "severity must be one of critical, high, medium, low";\n  }\n  for (const field of ["anchor", "title", "body"]) {\n    if (typeof input[field] !== "string" || input[field].trim().length === 0) {\n      return `${field} must be a non-blank string`;\n    }\n  }\n  return null;\n}\n\nexport default {\n  id: "report-finding",\n  async setup(ctx) {\n    const fs = await import("node:fs/promises");\n    const ndjsonPath = process.env.REVIEW_NDJSON_PATH;\n    const changedPathsPath = process.env.REVIEW_CHANGED_PATHS;\n    if (!ndjsonPath || !changedPathsPath) {\n      throw new Error("report-finding: REVIEW_NDJSON_PATH and REVIEW_CHANGED_PATHS are required");\n    }\n    const maxRecordBytes = positiveIntegerEnv("REVIEW_RECORD_LIMIT_BYTES", DEFAULT_MAX_RECORD_BYTES);\n    const maxFindings = positiveIntegerEnv("REVIEW_MAX_FINDINGS", DEFAULT_MAX_FINDINGS);\n    let allowedPaths;\n    try {\n      const parsed = JSON.parse(await fs.readFile(changedPathsPath, "utf8"));\n      if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {\n        throw new Error("expected a JSON array of strings");\n      }\n      allowedPaths = new Set(parsed);\n    } catch (error) {\n      throw new Error(`report-finding: cannot load REVIEW_CHANGED_PATHS: ${error.message}`);\n    }\n\n    // One promise-chain mutex serializes appends across concurrent tool calls.\n    let tail = Promise.resolve();\n    let accepted = 0;\n    const serialize = (operation) => {\n      const result = tail.then(operation, operation);\n      tail = result.then(() => undefined, () => undefined);\n      return result;\n    };\n\n    await ctx.tool.transform((editor) => editor.add({\n      name: "report_finding",\n      description: "Report one candidate review finding with HEAD line numbers, the exact anchor code, severity, title and body.",\n      input: REPORT_FINDING_SCHEMA,\n      options: { codemode: false },\n      async execute(input) {\n        const rejection = rejectionFor(input, allowedPaths);\n        if (rejection !== null) {\n          return { content: JSON.stringify({ queued: false, reason: rejection }) };\n        }\n        return serialize(async () => {\n          if (accepted >= maxFindings) {\n            return { content: JSON.stringify({ queued: false, reason: `max-findings limit (${maxFindings}) reached` }) };\n          }\n          const line = JSON.stringify(input);\n          if (Buffer.byteLength(line, "utf8") > maxRecordBytes) {\n            return { content: JSON.stringify({ queued: false, reason: `record exceeds ${maxRecordBytes} bytes` }) };\n          }\n          await fs.appendFile(ndjsonPath, `${line}\\n`, "utf8");\n          accepted += 1;\n          return { content: JSON.stringify({ queued: true }) };\n        });\n      },\n    }));\n  },\n};\n';

// src/templates.ts
var moduleValue = report_finding_plugin_default;
var reportFindingTemplate = typeof moduleValue === "string" ? moduleValue : readFileSync(new URL("../templates/report-finding.plugin.ts", import.meta.url), "utf8");

// src/opencode.ts
var MAX_RECORD_BYTES = 32 * 1024;
var MAX_NDJSON_BYTES = 4 * 1024 * 1024;
var MAX_TAIL_BYTES = 64 * 1024;
var MAX_LOG_BYTES = 2 * 1024 * 1024;
var KILL_GRACE_MS = 3e3;
var MAX_SKILL_FILES = 256;
var MAX_SKILL_BYTES = 1024 * 1024;
var MAX_PROMPT_PATHS = 500;
var AGENT_NAME = "reviewer";
var SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+){0,63}$/;
var SHA_PATTERN = /^[0-9a-f]{40}$/i;
var WORKSPACE_EXCLUDED_DIRECTORIES = [".opencode"];
var WORKSPACE_EXCLUDED_FILES = ["opencode.json", "opencode.jsonc"];
var WORKSPACE_ENV_PREFIX = ".env";
var ReviewRunError = class extends Error {
  kind;
  fields;
  constructor(kind, message, fields = []) {
    super(message);
    this.name = "ReviewRunError";
    this.kind = kind;
    this.fields = fields;
  }
};
function excerpt3(text, limit = 300) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}
var BoundedBuffer = class {
  chunks = [];
  size = 0;
  limit;
  constructor(limit) {
    this.limit = limit;
  }
  push(chunk) {
    if (this.size >= this.limit) {
      return;
    }
    const remaining = this.limit - this.size;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(slice);
    this.size += slice.length;
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
};
async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
var providerCredentialNames = {
  anthropic: ["ANTHROPIC_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-vertex": ["GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  xai: ["XAI_API_KEY"]
};
var forbiddenChildEnvNames = /^(TYPESAFE_[A-Z0-9_]*|GITHUB_TOKEN|GH_TOKEN)$/;
function providerFromModel(model) {
  const withoutVariant = model.split("#", 1)[0] ?? model;
  return withoutVariant.split("/", 1)[0] ?? withoutVariant;
}
function buildChildEnvironment(input) {
  const parent = input.parentEnv;
  const path = parent["PATH"];
  if (!path || path.trim().length === 0) {
    throw new ReviewRunError("config", "PATH is required to spawn OpenCode", ["PATH"]);
  }
  const env = {
    PATH: path,
    HOME: input.homeDir,
    XDG_CONFIG_HOME: join(input.homeDir, ".config"),
    TMPDIR: input.tempDir,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    REVIEW_NDJSON_PATH: input.ndjsonPath,
    REVIEW_CHANGED_PATHS: input.changedPathsPath,
    REVIEW_CANARY_MARKER: input.canaryMarkerPath,
    REVIEW_MAX_FINDINGS: String(input.maxFindings),
    REVIEW_RECORD_LIMIT_BYTES: String(input.recordLimitBytes)
  };
  for (const name of ["LANG", "LC_ALL"]) {
    const value = parent[name];
    if (value !== void 0 && value.length > 0) {
      env[name] = value;
    }
  }
  const provider = providerFromModel(input.model);
  let providerKeyName = null;
  for (const name of providerCredentialNames[provider] ?? []) {
    const value = parent[name];
    if (value !== void 0 && value.length > 0) {
      env[name] = value;
      providerKeyName = name;
      break;
    }
  }
  const protectedValues = [
    ...input.protectedValues ?? [],
    parent["TYPESAFE_API_KEY"],
    parent["GITHUB_TOKEN"],
    parent["GH_TOKEN"]
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const [name, value] of Object.entries(env)) {
    if (protectedValues.includes(value)) {
      throw new ReviewRunError("config", `refusing to pass ${name}: value equals a protected secret`, [name]);
    }
  }
  for (const name of Object.keys(env)) {
    if (forbiddenChildEnvNames.test(name)) {
      throw new ReviewRunError("config", `internal allowlist error: ${name} must never reach the child`, [name]);
    }
  }
  return { env, providerKeyName };
}
function buildOpenCodeCommand(input) {
  return {
    command: input.cliPath,
    args: ["run", "--standalone", "--format", "json", "--agent", input.agent, "--model", input.model, input.prompt]
  };
}
function buildReviewerPrompt(skillName, changedPaths) {
  const listed = changedPaths.slice(0, MAX_PROMPT_PATHS);
  const list = listed.map((path) => `- ${path}`).join("\n");
  const omitted = changedPaths.length - listed.length;
  const more = omitted > 0 ? `
- ... and ${omitted} more changed files` : "";
  return [
    "You review one pull request as the finding producer for an automated review pipeline.",
    "",
    "Workspace:",
    "- The current working directory is a checkout pinned to the PR HEAD. Treat it as read-only.",
    "- Only these files were changed by this PR; report findings only for these paths:",
    list + more,
    "",
    "Process:",
    `1. Load the "${skillName}" skill and follow its review criteria.`,
    "2. Read the changed files and enough surrounding code to understand the behavior.",
    "3. Call report_finding once per concrete problem. It is the only formal output channel; text output is not read by the pipeline.",
    "4. If you find no concrete problem, finish without calling report_finding.",
    "",
    "report_finding fields:",
    "- path: one of the changed paths above (repository-relative, HEAD/new side).",
    "- candidateStart, candidateEnd: 1-based inclusive line numbers in the HEAD file, candidateStart <= candidateEnd.",
    "- anchor: the exact contiguous source text of those lines, copied verbatim from the read tool output instead of retyping. Keep every character, including leading whitespace and indentation; never trim, re-indent, or add markdown fences.",
    '- anchor example: correct "  return n - 1;" (two leading spaces kept); wrong "return n - 1;" (indentation lost).',
    "- severity: critical | high | medium | low by concrete impact.",
    "- title: short problem name. body: trigger, evidence and impact.",
    "",
    "The pipeline re-checks path, line numbers and anchor against the fixed HEAD; incorrect values are rejected or dropped."
  ].join("\n");
}
function reviewerPermissions(skillName, skillDir) {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "skill", resource: skillName, effect: "allow" },
    { action: "report_finding", resource: "*", effect: "allow" },
    { action: "external_directory", resource: `${skillDir}/*`, effect: "allow" }
  ];
}
var CANARY_PLUGIN_FILE = "canary.ts";
var REPORT_FINDING_PLUGIN_FILE = "report-finding.ts";
var canaryPluginText = `// Managed canary plugin: proves that the managed OpenCode config was loaded.
// The marker path comes from the Action-injected environment, never from model input.
export default {
  id: "review-config-canary",
  async setup() {
    const marker = process.env.REVIEW_CANARY_MARKER;
    if (!marker) return;
    const fs = await import("node:fs/promises");
    await fs.writeFile(marker, "loaded", "utf8");
  },
};
`;
function yamlString(value) {
  return JSON.stringify(value);
}
function permissionsYaml(permissions) {
  return permissions.map((rule) => `  - { action: ${yamlString(rule.action)}, resource: ${yamlString(rule.resource)}, effect: ${yamlString(rule.effect)} }`).join("\n");
}
async function stageManagedConfigDir(input) {
  const configDir = join(input.tempHome, ".config", "opencode");
  const agentPath = join(configDir, "agents", `${AGENT_NAME}.md`);
  const pluginsDir = join(configDir, "plugins");
  const skillsDir = join(configDir, "skills");
  const reportFindingPluginPath = join(pluginsDir, REPORT_FINDING_PLUGIN_FILE);
  const canaryPluginPath = join(pluginsDir, CANARY_PLUGIN_FILE);
  await mkdir(join(configDir, "agents"), { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });
  const permissions = reviewerPermissions(input.skillName, input.skillDir);
  const config = {
    $schema: "https://opencode.ai/config.json",
    permissions
  };
  await writeFile(join(configDir, "opencode.json"), `${JSON.stringify(config, null, 2)}
`, "utf8");
  const agent = [
    "---",
    `description: ${yamlString("OpenCode review producer for one pull request")}`,
    "mode: primary",
    "permissions:",
    permissionsYaml(permissions),
    "---",
    input.prompt,
    ""
  ].join("\n");
  await writeFile(agentPath, agent, "utf8");
  await writeFile(reportFindingPluginPath, reportFindingTemplate, "utf8");
  await writeFile(canaryPluginPath, canaryPluginText, "utf8");
  return { configDir, agentPath, reportFindingPluginPath, canaryPluginPath, skillsDir };
}
function skillBodyFromMarkdown(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    return "";
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return "";
  }
  return lines.slice(end + 1).join("\n").trim();
}
function parseSkillFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new ReviewRunError("skill", "SKILL.md must start with YAML frontmatter", ["SKILL.md"]);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter is not terminated", ["SKILL.md"]);
  }
  let name;
  let description;
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const key = match[1];
    const rawValue = (match[2] ?? "").trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2").trim();
    if (key === "name") {
      name = value;
    }
    if (key === "description") {
      description = value;
    }
  }
  if (name === void 0 || !SKILL_NAME_PATTERN.test(name)) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter name is missing or invalid", ["SKILL.md", "name"]);
  }
  if (description === void 0 || description.length === 0 || description.length > 1024) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter description must be 1..1024 characters", ["SKILL.md", "description"]);
  }
  if (/^[|>]/.test(description)) {
    throw new ReviewRunError("skill", "SKILL.md frontmatter description must be a single-line value", ["SKILL.md", "description"]);
  }
  return { name, description };
}
function parseLsTreeZ(output) {
  return output.split("\0").filter((record) => record.length > 0).map((record) => {
    const tabIndex = record.indexOf("	");
    const meta = record.slice(0, tabIndex).split(" ");
    return {
      mode: meta[0] ?? "",
      type: meta[1] ?? "",
      path: record.slice(tabIndex + 1)
    };
  });
}
var GitCommandError = class extends Error {
  status;
  constructor(status) {
    super(`git exited with status ${status}`);
    this.name = "GitCommandError";
    this.status = status;
  }
};
function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) {
    throw new GitCommandError(-1);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function runGitBytes(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (result.error) {
    throw new GitCommandError(-1);
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  return { status: result.status ?? 1, stdout, stderr: typeof result.stderr === "string" ? result.stderr : "" };
}
function gitOrThrow(args, cwd, kind, fields) {
  let result;
  try {
    result = runGit(args, cwd);
  } catch {
    throw new ReviewRunError(kind, `git ${args[0] ?? ""} could not start`, fields);
  }
  if (result.status !== 0) {
    throw new ReviewRunError(kind, `git ${args[0] ?? ""} failed: ${excerpt3(result.stderr)}`, fields);
  }
  return result.stdout;
}
function gitShowBytes(workspace, revision, path, kind, fields) {
  let result;
  try {
    result = runGitBytes(["show", `${revision}:${path}`], workspace);
  } catch {
    throw new ReviewRunError(kind, "git show could not start", fields);
  }
  if (result.status !== 0) {
    throw new ReviewRunError(kind, `git show ${path} failed`, fields);
  }
  return result.stdout;
}
async function stageSkillFromHead(input) {
  if (!SKILL_NAME_PATTERN.test(input.skillName)) {
    throw new ReviewRunError("skill", "skill name is invalid", ["skill"]);
  }
  const prefix = `.opencode/skills/${input.skillName}`;
  const skillFile = gitShowBytes(input.workspace, input.headSha, `${prefix}/SKILL.md`, "skill", ["skill"]);
  const skillText = skillFile.toString("utf8");
  const frontmatter = parseSkillFrontmatter(skillText);
  if (frontmatter.name !== input.skillName) {
    throw new ReviewRunError(
      "skill",
      `SKILL.md name "${frontmatter.name}" does not match the requested skill "${input.skillName}"`,
      ["skill"]
    );
  }
  const treeOutput = gitOrThrow(["ls-tree", "-r", "-z", input.headSha, "--", prefix], input.workspace, "skill", ["skill"]);
  const entries = parseLsTreeZ(treeOutput);
  if (entries.length === 0 || entries.length > MAX_SKILL_FILES) {
    throw new ReviewRunError("skill", `skill must contain 1..${MAX_SKILL_FILES} files`, ["skill"]);
  }
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.type !== "blob" || !/^100(644|755)$/.test(entry.mode)) {
      throw new ReviewRunError("skill", "skill directory contains a symlink, submodule or non-regular file", ["skill"]);
    }
    const relativePath = relative(prefix, entry.path);
    if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new ReviewRunError("skill", "skill entry escapes its directory", ["skill"]);
    }
    const bytes = gitShowBytes(input.workspace, input.headSha, entry.path, "skill", ["skill"]);
    totalBytes += bytes.length;
    if (totalBytes > MAX_SKILL_BYTES) {
      throw new ReviewRunError("skill", `skill exceeds ${MAX_SKILL_BYTES} bytes`, ["skill"]);
    }
    files.push({ relativePath, bytes });
  }
  const stagedDir = join(input.skillsRoot, input.skillName);
  await mkdir(stagedDir, { recursive: true });
  for (const file of files) {
    const target = join(stagedDir, file.relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.bytes);
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    sourceDir: prefix,
    stagedDir,
    fileCount: files.length,
    criteria: skillCriteriaExcerpt(skillBodyFromMarkdown(skillText))
  };
}
async function extractHeadArchive(input) {
  await mkdir(input.destDir, { recursive: true });
  const archiveErr = new BoundedBuffer(8192);
  const tarErr = new BoundedBuffer(8192);
  try {
    const archive = spawn("git", ["-C", input.workspace, "archive", "--format=tar", input.headSha], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const tar = spawn("tar", ["-x", "-C", input.destDir], {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true
    });
    archive.stderr.on("data", (chunk) => archiveErr.push(chunk));
    tar.stderr.on("data", (chunk) => tarErr.push(chunk));
    archive.stdout.pipe(tar.stdin);
    const [archiveExit, tarExit] = await Promise.all([waitForClose(archive), waitForClose(tar)]);
    if (archiveExit.code !== 0) {
      throw new ReviewRunError("workspace", `git archive failed: ${excerpt3(archiveErr.text())}`, ["workspace"]);
    }
    if (tarExit.code !== 0) {
      throw new ReviewRunError("workspace", `tar failed: ${excerpt3(tarErr.text())}`, ["workspace"]);
    }
  } catch (error) {
    if (error instanceof ReviewRunError) {
      throw error;
    }
    throw new ReviewRunError("workspace", `extracting the PR HEAD failed: ${error instanceof Error ? error.name : "unknown error"}`, ["workspace"]);
  }
}
function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
async function applyWorkspaceExclusions(root) {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const excluded = entry.isDirectory() && WORKSPACE_EXCLUDED_DIRECTORIES.includes(entry.name) || WORKSPACE_EXCLUDED_FILES.includes(entry.name) || entry.name.startsWith(WORKSPACE_ENV_PREFIX);
      if (excluded) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }
}
function parseNameStatusZ(output) {
  const tokens = output.split("\0");
  const changes = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (!status) {
      continue;
    }
    const code = status.slice(0, 1).toUpperCase();
    if (code === "R" || code === "C") {
      const previousPath = tokens[index];
      const path = tokens[index + 1];
      index += 2;
      if (!previousPath || !path) {
        throw new ReviewRunError("changed_paths", "git diff --name-status output was truncated", ["changed_paths"]);
      }
      changes.push({ status, path, previousPath });
    } else {
      const path = tokens[index];
      index += 1;
      if (!path) {
        throw new ReviewRunError("changed_paths", "git diff --name-status output was truncated", ["changed_paths"]);
      }
      changes.push({ status, path });
    }
  }
  return changes;
}
function crossCheckChangedPaths(local, remote) {
  const remotePaths = [...new Set(remote.map((file) => file.filename))].sort();
  const localSet = new Set(local.map((change) => change.path));
  for (const file of remote) {
    if (file.status === "renamed" && file.previous_filename) {
      localSet.delete(file.previous_filename);
    }
  }
  const localPaths = [...localSet].sort();
  const equal = localPaths.length === remotePaths.length && localPaths.every((path, index) => path === remotePaths[index]);
  return equal ? { ok: true, paths: remotePaths } : { ok: false, local: localPaths, remote: remotePaths };
}
function wrapGitHubError(error, what) {
  if (error instanceof ReviewRunError) {
    return error;
  }
  if (error instanceof Error && error.name === "HeadChangedError") {
    return new ReviewRunError("head_changed", error.message, ["head.sha"]);
  }
  const message = error instanceof Error ? error.message : "unknown error";
  return new ReviewRunError("github", `${what}: ${message}`, ["github"]);
}
async function prepareReviewContext(input, deps = {}) {
  const readPullRequest = deps.getPullRequest ?? getPullRequest;
  const readChangedFiles = deps.listChangedFiles ?? listChangedFiles;
  const { context } = input;
  let live;
  try {
    live = await readPullRequest(input.token, context.repository, context.pullNumber, {
      signal: input.signal,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl
    });
  } catch (error) {
    throw wrapGitHubError(error, "reading pull request metadata");
  }
  if (live.head.sha.toLowerCase() !== context.headSha.toLowerCase()) {
    throw new ReviewRunError(
      "head_changed",
      `PR head changed during context: event ${context.headSha}, live ${live.head.sha.toLowerCase()}`,
      ["head.sha"]
    );
  }
  if (live.head.repo.full_name.toLowerCase() !== context.repository.toLowerCase()) {
    throw new ReviewRunError("head_changed", "PR head repository changed during context", ["head.repo.full_name"]);
  }
  const head = gitOrThrow(["rev-parse", "HEAD"], input.workspace, "workspace", ["GITHUB_WORKSPACE"]).trim().toLowerCase();
  if (!SHA_PATTERN.test(head)) {
    throw new ReviewRunError("workspace", "workspace HEAD is not a commit sha", ["GITHUB_WORKSPACE"]);
  }
  if (head !== context.headSha.toLowerCase()) {
    throw new ReviewRunError("workspace", "workspace is not checked out at the PR head", ["GITHUB_WORKSPACE"]);
  }
  gitOrThrow(["cat-file", "-e", `${context.baseSha}^{commit}`], input.workspace, "workspace", ["base.sha"]);
  const mergeBase = gitOrThrow(["merge-base", context.baseSha, context.headSha], input.workspace, "workspace", ["base.sha"]).trim().toLowerCase();
  if (!SHA_PATTERN.test(mergeBase)) {
    throw new ReviewRunError("workspace", "merge-base did not return a commit sha", ["base.sha"]);
  }
  const diffOutput = gitOrThrow(
    ["diff", "--name-status", "-z", "-M", "--no-ext-diff", "--no-textconv", mergeBase, context.headSha],
    input.workspace,
    "changed_paths",
    ["changed_paths"]
  );
  const local = parseNameStatusZ(diffOutput);
  let remote;
  try {
    remote = await readChangedFiles(input.token, context.repository, context.pullNumber, {
      signal: input.signal,
      baseUrl: deps.baseUrl,
      fetchImpl: deps.fetchImpl
    });
  } catch (error) {
    throw wrapGitHubError(error, "reading changed files");
  }
  const check2 = crossCheckChangedPaths(local, remote);
  if (!check2.ok) {
    throw new ReviewRunError(
      "changed_paths",
      `changed path sets differ (local ${check2.local.length}, GitHub ${check2.remote.length})`,
      ["changed_paths"]
    );
  }
  return { context, mergeBase, changedPaths: check2.paths, workspace: input.workspace };
}
async function runOpenCodeSession(options) {
  const tailLimit = options.tailBytes ?? MAX_TAIL_BYTES;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const stdout = new BoundedBuffer(tailLimit);
  const stderr = new BoundedBuffer(tailLimit);
  const stdoutLog = options.stdoutLogPath ? new BoundedBuffer(MAX_LOG_BYTES) : null;
  const stderrLog = options.stderrLogPath ? new BoundedBuffer(MAX_LOG_BYTES) : null;
  const outcome = await new Promise((resolveOutcome) => {
    let settled = false;
    let kind = "exit";
    let timeoutTimer;
    let killTimer;
    let hardStopTimer;
    let child;
    let spawnError;
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(hardStopTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveOutcome(result);
    };
    const kill = (signal) => {
      try {
        child.kill(signal);
      } catch {
      }
    };
    const onAbort = () => {
      kind = "cancelled";
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), grace);
    };
    const tails = () => ({ stdoutTail: stdout.text(), stderrTail: stderr.text() });
    try {
      child = spawn(options.command.command, options.command.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error("spawn failed");
      finish({ kind: "spawn-error", code: null, signal: null, ...tails(), message: spawnError.name });
      return;
    }
    child.stdout?.on("data", (chunk) => {
      stdout.push(chunk);
      stdoutLog?.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr.push(chunk);
      stderrLog?.push(chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
      finish({ kind: "spawn-error", code: null, signal: null, ...tails(), message: error.name });
    });
    child.once("close", (code, signal) => {
      finish({ kind, code, signal, ...tails() });
    });
    if (options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        kind = "timeout";
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), grace);
        hardStopTimer = setTimeout(() => {
          finish({ kind: "timeout", code: null, signal: null, ...tails() });
        }, grace + 5e3);
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    if (spawnError) {
      finish({ kind: "spawn-error", code: null, signal: null, ...tails(), message: spawnError.name });
    }
  });
  if (options.stdoutLogPath && stdoutLog) {
    await writeFile(options.stdoutLogPath, stdoutLog.text(), "utf8").catch(() => void 0);
  }
  if (options.stderrLogPath && stderrLog) {
    await writeFile(options.stderrLogPath, stderrLog.text(), "utf8").catch(() => void 0);
  }
  return outcome;
}
function rejectReason(issues) {
  const issue = issues[0];
  if (!issue) {
    return "schema validation failed";
  }
  const path = issue.path?.map((item) => String(item.key)).join(".") ?? "";
  const message = excerpt3(issue.message, 120);
  return path.length > 0 ? `${path}: ${message}` : message;
}
async function readFindings(input) {
  let size;
  try {
    size = (await stat(input.ndjsonPath)).size;
  } catch {
    throw new ReviewRunError("ndjson_missing", "findings file is missing", ["findings.ndjson"]);
  }
  if (size > MAX_NDJSON_BYTES) {
    throw new ReviewRunError("ndjson_too_large", `findings file exceeds ${MAX_NDJSON_BYTES} bytes`, ["findings.ndjson"]);
  }
  const text = await readFile(input.ndjsonPath, "utf8");
  if (text.length === 0) {
    return { findings: [], rejected: [], lineCount: 0 };
  }
  if (!text.endsWith("\n")) {
    throw new ReviewRunError("ndjson_corrupt", "findings file ends with a partial line", ["findings.ndjson"]);
  }
  const lines = text.slice(0, -1).split("\n");
  const findings = [];
  const rejected = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      throw new ReviewRunError("ndjson_corrupt", `findings file has an empty line at line ${lineNumber}`, ["findings.ndjson"]);
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new ReviewRunError("ndjson_corrupt", `findings file has an unparseable line at line ${lineNumber}`, ["findings.ndjson"]);
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new ReviewRunError("ndjson_corrupt", `findings record at line ${lineNumber} is not an object`, ["findings.ndjson"]);
    }
    const parsed = safeParse(reportFindingInputSchema, record);
    if (!parsed.success) {
      rejected.push({ line: lineNumber, reason: rejectReason(parsed.issues) });
      continue;
    }
    if (findings.length >= input.maxFindings) {
      throw new ReviewRunError("limit_exceeded", `findings file exceeds max-findings (${input.maxFindings})`, ["max-findings"]);
    }
    const entry = parsed.output;
    findings.push({
      id: randomUUID(),
      skill: input.skill,
      path: entry.path,
      candidateRange: { start: entry.candidateStart, end: entry.candidateEnd, anchor: entry.anchor },
      severity: entry.severity,
      title: entry.title,
      body: entry.body
    });
  }
  return { findings, rejected, lineCount: lines.length };
}
async function createReviewStaging(runnerTemp) {
  const root = await mkdtemp(join(runnerTemp, "review-"));
  return {
    root,
    homeDir: join(root, "home"),
    workspaceDir: join(root, "workspace"),
    ndjsonPath: join(root, "findings.ndjson"),
    changedPathsPath: join(root, "changed-paths.json"),
    canaryMarkerPath: join(root, "canary.marker"),
    stdoutLogPath: join(root, "opencode.stdout.log"),
    stderrLogPath: join(root, "opencode.stderr.log")
  };
}
async function runFindingProducer(options) {
  const keepArtifacts = options.keepArtifacts ?? options.parentEnv["REVIEW_KEEP_ARTIFACTS"] === "1";
  const staging = await createReviewStaging(options.runnerTemp);
  try {
    await writeFile(staging.changedPathsPath, JSON.stringify(options.prepared.changedPaths), "utf8");
    await writeFile(staging.ndjsonPath, "", "utf8");
    await extractHeadArchive({
      workspace: options.prepared.workspace,
      headSha: options.prepared.context.headSha,
      destDir: staging.workspaceDir
    });
    await applyWorkspaceExclusions(staging.workspaceDir);
    const skillDir = join(staging.homeDir, ".config", "opencode", "skills", options.prepared.context.skill);
    await stageManagedConfigDir({
      tempHome: staging.homeDir,
      skillName: options.prepared.context.skill,
      skillDir,
      prompt: buildReviewerPrompt(options.prepared.context.skill, options.prepared.changedPaths)
    });
    const stagedSkill = await stageSkillFromHead({
      workspace: options.prepared.workspace,
      headSha: options.prepared.context.headSha,
      skillName: options.prepared.context.skill,
      skillsRoot: join(staging.homeDir, ".config", "opencode", "skills")
    });
    const childEnvironment = buildChildEnvironment({
      parentEnv: options.parentEnv,
      model: options.model,
      homeDir: staging.homeDir,
      tempDir: staging.root,
      ndjsonPath: staging.ndjsonPath,
      changedPathsPath: staging.changedPathsPath,
      canaryMarkerPath: staging.canaryMarkerPath,
      maxFindings: options.maxFindings,
      recordLimitBytes: MAX_RECORD_BYTES,
      protectedValues: options.protectedValues
    });
    const command = options.command ?? buildOpenCodeCommand({
      cliPath: options.cliPath ?? options.parentEnv["OPENCODE_CLI"] ?? "opencode",
      model: options.model,
      agent: AGENT_NAME,
      prompt: buildReviewerPrompt(options.prepared.context.skill, options.prepared.changedPaths)
    });
    const exit = await runOpenCodeSession({
      command,
      cwd: staging.workspaceDir,
      env: childEnvironment.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      stdoutLogPath: staging.stdoutLogPath,
      stderrLogPath: staging.stderrLogPath,
      killGraceMs: options.killGraceMs
    });
    if (exit.kind === "timeout") {
      throw new ReviewRunError("timeout", `OpenCode timed out after ${options.timeoutMs} ms`, ["timeout"]);
    }
    if (exit.kind === "cancelled") {
      throw new ReviewRunError("cancelled", "OpenCode invocation was cancelled", ["cancelled"]);
    }
    if (exit.kind === "spawn-error") {
      throw new ReviewRunError("spawn", `OpenCode could not start: ${exit.message ?? "unknown error"}`, ["opencode"]);
    }
    if (exit.code !== 0) {
      throw new ReviewRunError(
        "producer",
        `OpenCode exited with code ${exit.code}; stderr: ${excerpt3(exit.stderrTail)}`,
        ["exit"]
      );
    }
    const canaryPresent = await fileExists(staging.canaryMarkerPath);
    if (!canaryPresent) {
      throw new ReviewRunError("config", "managed OpenCode config was not loaded (canary marker missing)", ["canary"]);
    }
    const read = await readFindings({
      ndjsonPath: staging.ndjsonPath,
      skill: options.prepared.context.skill,
      maxFindings: options.maxFindings
    });
    return {
      ...read,
      canaryPresent,
      stagingDir: staging.root,
      exit,
      skillCriteria: { name: stagedSkill.name, criteria: stagedSkill.criteria }
    };
  } finally {
    if (!keepArtifacts) {
      await rm(staging.root, { recursive: true, force: true });
    }
  }
}

// src/range.ts
import { spawnSync as spawnSync2 } from "node:child_process";
var MAX_BLOB_BYTES = 2 * 1024 * 1024;
var MAX_BLOB_LINES = 5e4;
var DEFAULT_EVIDENCE_CONTEXT_LINES = 5;
var MAX_CORRECTION_EXPANSION_LINES = 3;
var DIFF_MAX_BUFFER = 64 * 1024 * 1024;
var BLOB_MAX_BUFFER = 16 * 1024 * 1024;
var RangeRunError = class extends Error {
  kind;
  fields;
  constructor(kind, message, fields = []) {
    super(message);
    this.name = "RangeRunError";
    this.kind = kind;
    this.fields = fields;
  }
};
function excerpt4(text, limit = 300) {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}...` : singleLine;
}
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
function parseHunkHeader(header) {
  const match = HUNK_HEADER.exec(header);
  if (!match) {
    throw new RangeRunError("diff", "cannot parse a hunk header", ["diff"]);
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === void 0 ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === void 0 ? 1 : Number(match[4]),
    section: (match[5] ?? "").trim()
  };
}
function newFileBuilder(header) {
  return {
    header,
    status: "modified",
    binary: false,
    similarity: null,
    hunks: [],
    sawNewFile: false,
    sawDeletedFile: false,
    oldMarkerPath: null,
    newMarkerPath: null,
    renameFrom: null,
    renameTo: null,
    binaryOldPath: null,
    binaryNewPath: null
  };
}
function stripMarkerPrefix(value, prefix) {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
function markerPath(value, prefix) {
  const path = value.endsWith("	") ? value.slice(0, -1) : value;
  return path === "/dev/null" ? null : stripMarkerPrefix(path, prefix);
}
function parseBinaryLine(line) {
  const match = /^Binary files (.*) and (.*) differ$/.exec(line);
  if (!match) {
    return { oldPath: null, newPath: null };
  }
  const oldRaw = match[1] ?? "";
  const newRaw = match[2] ?? "";
  return {
    oldPath: oldRaw === "/dev/null" ? null : stripMarkerPrefix(oldRaw, "a/"),
    newPath: newRaw === "/dev/null" ? null : stripMarkerPrefix(newRaw, "b/")
  };
}
function fallbackPathFromHeader(header) {
  const rest = header.slice("diff --git ".length);
  if (!rest.startsWith("a/")) {
    return null;
  }
  let searchFrom = 2;
  for (; ; ) {
    const index = rest.indexOf(" b/", searchFrom);
    if (index === -1) {
      return null;
    }
    const left = rest.slice(0, index);
    const right = rest.slice(index + 3);
    if (left === `a/${right}`) {
      return right;
    }
    searchFrom = index + 1;
  }
}
function builderStatus(builder) {
  if (builder.renameTo !== null) {
    return "renamed";
  }
  if (builder.sawNewFile) {
    return "added";
  }
  if (builder.sawDeletedFile) {
    return "deleted";
  }
  return "modified";
}
function builderPath(builder) {
  const status = builderStatus(builder);
  if (status === "deleted") {
    return builder.oldMarkerPath ?? builder.renameFrom ?? builder.binaryOldPath ?? fallbackPathFromHeader(builder.header);
  }
  if (status === "renamed") {
    return builder.renameTo;
  }
  if (status === "added") {
    return builder.newMarkerPath ?? builder.binaryNewPath ?? fallbackPathFromHeader(builder.header);
  }
  return builder.newMarkerPath ?? builder.oldMarkerPath ?? builder.binaryNewPath ?? builder.binaryOldPath ?? fallbackPathFromHeader(builder.header);
}
function bodyLine(raw, prefix, currentOldLine, currentNewLine) {
  const text = raw.slice(1);
  if (prefix === "+") {
    return { kind: "added", raw, text, newLineNumber: currentNewLine(), oldLineNumber: null };
  }
  if (prefix === "-") {
    return { kind: "removed", raw, text, newLineNumber: null, oldLineNumber: currentOldLine() };
  }
  if (prefix === " ") {
    return { kind: "context", raw, text, newLineNumber: currentNewLine(), oldLineNumber: currentOldLine() };
  }
  return { kind: "meta", raw, text, newLineNumber: null, oldLineNumber: null };
}
function parseUnifiedDiff(text) {
  const files = /* @__PURE__ */ new Map();
  let builder = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const finishHunk = () => {
    if (builder !== null && hunk !== null) {
      builder.hunks.push({ ...hunk });
    }
    hunk = null;
  };
  const finishFile = () => {
    if (builder === null) {
      return;
    }
    const path = builderPath(builder);
    if (path !== null) {
      files.set(path, {
        path,
        status: builderStatus(builder),
        binary: builder.binary,
        hunks: builder.hunks,
        ...builder.renameFrom !== null ? { previousPath: builder.renameFrom } : {},
        ...builder.similarity !== null ? { similarity: builder.similarity } : {}
      });
    }
    builder = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      finishHunk();
      finishFile();
      builder = newFileBuilder(line);
      continue;
    }
    if (builder === null) {
      continue;
    }
    if (hunk !== null) {
      const prefix = line.charAt(0);
      if (prefix === "+" || prefix === "-" || prefix === " " || prefix === "\\") {
        hunk.lines.push(bodyLine(line, prefix, () => oldLine, () => newLine));
        if (prefix === "+") {
          newLine += 1;
        } else if (prefix === "-") {
          oldLine += 1;
        } else if (prefix === " ") {
          oldLine += 1;
          newLine += 1;
        }
        continue;
      }
      finishHunk();
    }
    if (line.startsWith("@@")) {
      const parsed = parseHunkHeader(line);
      hunk = {
        header: line,
        oldStart: parsed.oldStart,
        oldCount: parsed.oldCount,
        newStart: parsed.newStart,
        newCount: parsed.newCount,
        section: parsed.section,
        lines: []
      };
      oldLine = parsed.oldStart;
      newLine = parsed.newStart;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      builder.sawNewFile = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      builder.sawDeletedFile = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      builder.renameFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      builder.renameTo = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("similarity index ")) {
      const percent = /^similarity index (\d+)%$/.exec(line);
      builder.similarity = percent === null ? null : Number(percent[1]);
      continue;
    }
    if (line.startsWith("--- ")) {
      builder.oldMarkerPath = markerPath(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      builder.newMarkerPath = markerPath(line.slice(4), "b/");
      continue;
    }
    if (line.startsWith("Binary files ")) {
      const paths = parseBinaryLine(line);
      builder.binaryOldPath = paths.oldPath;
      builder.binaryNewPath = paths.newPath;
      builder.binary = true;
      continue;
    }
  }
  finishHunk();
  finishFile();
  return { files };
}
function stripTrailingCr(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
function splitBlobLines(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map(stripTrailingCr);
}
function splitAnchorLines(anchor) {
  return anchor.split("\n").map(stripTrailingCr);
}
function windowMatches(blobLines, anchorLines, startIndex) {
  for (let offset = 0; offset < anchorLines.length; offset += 1) {
    if (blobLines[startIndex + offset] !== anchorLines[offset]) {
      return false;
    }
  }
  return true;
}
var rangeSkipMessages = {
  candidate_invalid: "\u6307\u6458\u306E\u5019\u88DC\u884C\u7BC4\u56F2\u304C\u4E0D\u6B63\u3067\u3059\u3002",
  path_not_changed: "\u6307\u6458\u5BFE\u8C61\u306Epath\u304CPR\u306E\u5909\u66F4\u30D5\u30A1\u30A4\u30EB\u306B\u542B\u307E\u308C\u3066\u3044\u307E\u305B\u3093\u3002",
  path_unsafe: "path\u306B\u7D76\u5BFEpath\u30FB..\u30FBNUL\u30FB\u30D0\u30C3\u30AF\u30B9\u30E9\u30C3\u30B7\u30E5\u306A\u3069\u306E\u4E0D\u6B63\u306A\u8981\u7D20\u304C\u542B\u307E\u308C\u3066\u3044\u307E\u3059\u3002",
  file_binary: "\u6307\u6458\u5BFE\u8C61\u306Fbinary\u30D5\u30A1\u30A4\u30EB\u306E\u305F\u3081anchor\u3092\u691C\u8A3C\u3067\u304D\u307E\u305B\u3093\u3002",
  file_deleted: "\u6307\u6458\u5BFE\u8C61\u306E\u30D5\u30A1\u30A4\u30EB\u306FHEAD\u3067\u524A\u9664\u3055\u308C\u3066\u3044\u307E\u3059\u3002",
  file_symlink_or_submodule: "\u6307\u6458\u5BFE\u8C61\u306Fsymlink\u307E\u305F\u306Fsubmodule\u306E\u305F\u3081\u30B3\u30E1\u30F3\u30C8\u3067\u304D\u307E\u305B\u3093\u3002",
  blob_too_large: "\u6307\u6458\u5BFE\u8C61\u306Eblob\u304C\u30B5\u30A4\u30BA\u4E0A\u9650\uFF082 MiB\uFF09\u3092\u8D85\u3048\u3066\u3044\u307E\u3059\u3002",
  blob_line_limit: "\u6307\u6458\u5BFE\u8C61\u306Eblob\u304C\u884C\u6570\u4E0A\u9650\uFF0850,000\u884C\uFF09\u3092\u8D85\u3048\u3066\u3044\u307E\u3059\u3002",
  anchor_not_found: "anchor\u3068\u5B8C\u5168\u4E00\u81F4\u3059\u308B\u884C\u304CHEAD\u306B\u5B58\u5728\u3057\u307E\u305B\u3093\u3002",
  anchor_ambiguous: "anchor\u304CHEAD\u5185\u3067\u4E00\u610F\u306B\u7279\u5B9A\u3067\u304D\u307E\u305B\u3093\u3002",
  not_in_single_hunk: "\u78BA\u5B9A\u7BC4\u56F2\u304Cdiff\u306E\u540C\u4E00hunk\u5185\u306B\u53CE\u307E\u308A\u307E\u305B\u3093\u3002",
  no_changed_line_in_range: "\u78BA\u5B9A\u7BC4\u56F2\u306B\u8FFD\u52A0\u30FB\u5909\u66F4\u884C\u304C\u542B\u307E\u308C\u3066\u3044\u307E\u305B\u3093\u3002",
  range_retry_exhausted: "\u7BC4\u56F2\u306E\u518D\u89E3\u6C7A\u3092\u8A66\u307F\u307E\u3057\u305F\u304C\u3001\u540C\u3058\u7BC4\u56F2\u307E\u305F\u306F\u89E3\u6C7A\u4E0D\u80FD\u306E\u305F\u3081\u6253\u3061\u5207\u308A\u307E\u3057\u305F\u3002"
};
function skipOutcome(reason, detail = "") {
  const base = rangeSkipMessages[reason];
  return { kind: "skipped", reason, message: detail.length > 0 ? `${base} (${detail})` : base };
}
function isSafeRepoPath(path) {
  if (path.length === 0 || path.includes("\0") || path.includes("\\")) {
    return false;
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function hunkOf(diff, path, range) {
  const file = diff.files.get(path);
  if (!file) {
    return void 0;
  }
  return file.hunks.find(
    (hunk) => hunk.newCount > 0 && hunk.newStart <= range.startLine && range.endLine <= hunk.newStart + hunk.newCount - 1
  );
}
function hunksOverlappingRange(diff, path, range) {
  const file = diff.files.get(path);
  if (!file) {
    return [];
  }
  return file.hunks.filter(
    (hunk) => hunk.newCount > 0 && hunk.newStart <= range.endLine && range.startLine <= hunk.newStart + hunk.newCount - 1
  );
}
function addedLineNumbers(hunk) {
  const numbers = /* @__PURE__ */ new Set();
  for (const line of hunk.lines) {
    if (line.kind === "added" && line.newLineNumber !== null) {
      numbers.add(line.newLineNumber);
    }
  }
  return numbers;
}
function rangeHasAddedLine(added, start, end) {
  for (let line = start; line <= end; line += 1) {
    if (added.has(line)) {
      return true;
    }
  }
  return false;
}
function buildResolvedRange(path, headSha, startLine, endLine, anchorStartLine, blobLines) {
  return {
    path,
    commitId: headSha,
    startLine,
    endLine,
    anchorStartLine,
    side: "RIGHT",
    code: blobLines.slice(startLine - 1, endLine).join("\n")
  };
}
function closestToCandidate(indices, candidateStart) {
  let best = indices[0];
  let bestDistance = Math.abs(best + 1 - candidateStart);
  for (const index of indices.slice(1)) {
    const distance = Math.abs(index + 1 - candidateStart);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
function locateAnchor(finding, blobLines) {
  const anchorLines = splitAnchorLines(finding.candidateRange.anchor);
  const matches = [];
  for (let index = 0; index + anchorLines.length <= blobLines.length; index += 1) {
    if (windowMatches(blobLines, anchorLines, index)) {
      matches.push(index);
    }
  }
  if (matches.length === 0) {
    return skipOutcome("anchor_not_found");
  }
  const candidateStart = finding.candidateRange.start;
  const candidateEnd = finding.candidateRange.end;
  const inside = matches.filter(
    (index) => index + 1 >= candidateStart && index + anchorLines.length <= candidateEnd
  );
  if (inside.length > 0) {
    const chosen = closestToCandidate(inside, candidateStart);
    return { start: chosen + 1, end: chosen + anchorLines.length };
  }
  if (matches.length === 1) {
    const chosen = matches[0];
    return { start: chosen + 1, end: chosen + anchorLines.length };
  }
  return skipOutcome("anchor_ambiguous", `${matches.length} matches`);
}
function minimalCommentRange(input) {
  const hunk = hunkOf(input.diff, input.path, { startLine: input.anchorStart, endLine: input.anchorEnd });
  if (!hunk || hunk.newCount <= 0) {
    return skipOutcome("not_in_single_hunk");
  }
  const hunkStart = hunk.newStart;
  const hunkEnd = hunk.newStart + hunk.newCount - 1;
  if (input.anchorEnd > input.blobLines.length || hunkEnd > input.blobLines.length) {
    return skipOutcome("not_in_single_hunk", "blob is shorter than the hunk");
  }
  const added = addedLineNumbers(hunk);
  let start = input.anchorStart;
  let end = input.anchorEnd;
  while (start - 1 >= hunkStart && added.has(start - 1)) {
    start -= 1;
  }
  while (end + 1 <= hunkEnd && added.has(end + 1)) {
    end += 1;
  }
  if (!rangeHasAddedLine(added, start, end)) {
    return skipOutcome("no_changed_line_in_range");
  }
  return {
    kind: "resolved",
    range: buildResolvedRange(input.path, input.headSha, start, end, input.anchorStart, input.blobLines)
  };
}
function skippedFinding(finding, outcome) {
  return { finding, kind: "skipped", reason: outcome.reason, message: outcome.message };
}
function resolveFinding(input) {
  const { finding } = input;
  const { start, end } = finding.candidateRange;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return skippedFinding(finding, skipOutcome("candidate_invalid"));
  }
  if (!isSafeRepoPath(finding.path)) {
    return skippedFinding(finding, skipOutcome("path_unsafe", finding.path));
  }
  const file = input.diff.files.get(finding.path);
  if (!file) {
    return skippedFinding(finding, skipOutcome("path_not_changed"));
  }
  if (file.status === "deleted") {
    return skippedFinding(finding, skipOutcome("file_deleted"));
  }
  if (file.binary) {
    return skippedFinding(finding, skipOutcome("file_binary"));
  }
  const blob = input.loadBlob(file);
  if (blob.kind === "skipped") {
    return skippedFinding(finding, blob);
  }
  if (blob.binary) {
    return skippedFinding(finding, skipOutcome("file_binary"));
  }
  const anchor = locateAnchor(finding, blob.lines);
  if ("kind" in anchor) {
    return skippedFinding(finding, anchor);
  }
  const outcome = minimalCommentRange({
    diff: input.diff,
    path: finding.path,
    headSha: input.headSha,
    anchorStart: anchor.start,
    anchorEnd: anchor.end,
    blobLines: blob.lines
  });
  return outcome.kind === "resolved" ? { finding, kind: "resolved", range: outcome.range } : skippedFinding(finding, outcome);
}
function shrinkToAnchor(input) {
  const anchorLines = splitAnchorLines(input.finding.candidateRange.anchor);
  const anchorStart = input.previous.anchorStartLine;
  const anchorEnd = anchorStart + anchorLines.length - 1;
  if (anchorStart < 1 || anchorEnd > input.blobLines.length) {
    return skipOutcome("range_retry_exhausted", "anchor window is outside the blob");
  }
  if (!windowMatches(input.blobLines, anchorLines, anchorStart - 1)) {
    return skipOutcome("range_retry_exhausted", "anchor no longer matches the blob");
  }
  const outcome = minimalCommentRange({
    diff: input.diff,
    path: input.finding.path,
    headSha: input.previous.commitId,
    anchorStart,
    anchorEnd,
    blobLines: input.blobLines
  });
  if (outcome.kind === "skipped") {
    return skipOutcome("range_retry_exhausted", `shrink produced ${outcome.reason}`);
  }
  if (outcome.range.startLine === input.previous.startLine && outcome.range.endLine === input.previous.endLine) {
    return skipOutcome("range_retry_exhausted", "corrected range equals the previous range");
  }
  return outcome;
}
function expandWithinHunk(input) {
  const previous = input.previous;
  const hunk = hunkOf(input.diff, input.finding.path, previous);
  if (!hunk || hunk.newCount <= 0) {
    return skipOutcome("range_retry_exhausted", "no hunk contains the previous range");
  }
  if (previous.endLine > input.blobLines.length) {
    return skipOutcome("range_retry_exhausted", "previous range is outside the blob");
  }
  const hunkStart = hunk.newStart;
  const hunkEnd = hunk.newStart + hunk.newCount - 1;
  const added = addedLineNumbers(hunk);
  let runStart = previous.startLine;
  let runEnd = previous.endLine;
  while (runStart - 1 >= hunkStart && added.has(runStart - 1)) {
    runStart -= 1;
  }
  while (runEnd + 1 <= hunkEnd && added.has(runEnd + 1)) {
    runEnd += 1;
  }
  const expandedStart = Math.max(runStart, previous.startLine - MAX_CORRECTION_EXPANSION_LINES, hunkStart);
  const expandedEnd = Math.min(runEnd, previous.endLine + MAX_CORRECTION_EXPANSION_LINES, hunkEnd);
  if (expandedStart === previous.startLine && expandedEnd === previous.endLine) {
    return skipOutcome("range_retry_exhausted", "no wider deterministic range");
  }
  return {
    kind: "resolved",
    range: buildResolvedRange(
      input.finding.path,
      previous.commitId,
      expandedStart,
      expandedEnd,
      previous.anchorStartLine,
      input.blobLines
    )
  };
}
function reResolveForCorrection(input) {
  if (input.attempt !== 0) {
    return skipOutcome("range_retry_exhausted", "re-resolution limit reached");
  }
  if (input.quality === "correct") {
    return skipOutcome("range_retry_exhausted", "range quality is already correct");
  }
  if (input.quality === "wrong_location") {
    return skipOutcome("range_retry_exhausted", "wrong_location has no deterministic relocation");
  }
  if (input.previous.path !== input.finding.path) {
    return skipOutcome("range_retry_exhausted", "previous range is for a different path");
  }
  return input.quality === "too_wide" ? shrinkToAnchor(input) : expandWithinHunk(input);
}
function formatHunk(hunk) {
  return [hunk.header, ...hunk.lines.map((line) => line.raw)].join("\n");
}
function buildJevEvidence(input) {
  const context = input.contextLines ?? DEFAULT_EVIDENCE_CONTEXT_LINES;
  const hunks = hunksOverlappingRange(input.diff, input.path, input.range);
  return {
    contextBefore: input.blobLines.slice(Math.max(0, input.range.startLine - 1 - context), input.range.startLine - 1),
    contextAfter: input.blobLines.slice(input.range.endLine, input.range.endLine + context),
    diffHunks: hunks.map(formatHunk),
    evidenceTruncated: false
  };
}
function buildDiffModel(workspace, mergeBase, headSha) {
  const result = spawnSync2(
    "git",
    ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "-M", "--find-renames", mergeBase, headSha],
    { cwd: workspace, encoding: "utf8", maxBuffer: DIFF_MAX_BUFFER, windowsHide: true }
  );
  if (result.error) {
    throw new RangeRunError("diff", "git diff could not start", ["diff"]);
  }
  if (result.status !== 0) {
    throw new RangeRunError("diff", `git diff failed: ${excerpt4(result.stderr ?? "")}`, ["diff"]);
  }
  return parseUnifiedDiff(result.stdout ?? "");
}
function readLsTreeEntry(workspace, headSha, path) {
  const result = spawnSync2(
    "git",
    ["-c", "core.quotePath=false", "ls-tree", "-l", "-z", headSha, "--", path],
    { cwd: workspace, encoding: "utf8", maxBuffer: DIFF_MAX_BUFFER, windowsHide: true }
  );
  if (result.error) {
    throw new RangeRunError("git", "git ls-tree could not start", ["git"]);
  }
  if (result.status !== 0) {
    throw new RangeRunError("git", `git ls-tree failed: ${excerpt4(result.stderr ?? "")}`, ["git"]);
  }
  const record = (result.stdout ?? "").split("\0").find((entry) => entry.length > 0);
  if (record === void 0) {
    return void 0;
  }
  const tabIndex = record.indexOf("	");
  const meta = record.slice(0, tabIndex === -1 ? void 0 : tabIndex).split(" ");
  const mode = meta[0] ?? "";
  const sizeText = meta[3];
  const size = sizeText !== void 0 && /^\d+$/.test(sizeText) ? Number(sizeText) : null;
  return { mode, size };
}
function readHeadBlob(workspace, headSha, path) {
  const entry = readLsTreeEntry(workspace, headSha, path);
  if (entry === void 0) {
    return skipOutcome("file_deleted", "path is not in HEAD");
  }
  if (entry.mode === "120000" || entry.mode === "160000") {
    return skipOutcome("file_symlink_or_submodule", `mode ${entry.mode}`);
  }
  if (!/^100(644|755)$/.test(entry.mode)) {
    return skipOutcome("path_unsafe", `HEAD mode ${entry.mode}`);
  }
  if (entry.size !== null && entry.size > MAX_BLOB_BYTES) {
    return skipOutcome("blob_too_large", `${entry.size} bytes`);
  }
  const result = spawnSync2(
    "git",
    ["-c", "core.quotePath=false", "show", `${headSha}:${path}`],
    { cwd: workspace, encoding: "buffer", maxBuffer: BLOB_MAX_BUFFER, windowsHide: true }
  );
  if (result.error) {
    throw new RangeRunError("git", "git show could not start", ["git"]);
  }
  if (result.status !== 0) {
    throw new RangeRunError("git", `git show ${path} failed`, ["git"]);
  }
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  if (bytes.length > MAX_BLOB_BYTES) {
    return skipOutcome("blob_too_large", `${bytes.length} bytes`);
  }
  if (bytes.includes(0)) {
    return skipOutcome("file_binary");
  }
  const lines = splitBlobLines(bytes.toString("utf8"));
  if (lines.length > MAX_BLOB_LINES) {
    return skipOutcome("blob_line_limit", `${lines.length} lines`);
  }
  return { kind: "ok", byteLength: bytes.length, binary: false, lines };
}
function assertChangedPaths(diff, changedPaths) {
  const remote = new Set(changedPaths);
  for (const path of remote) {
    if (!diff.files.has(path)) {
      throw new RangeRunError("changed_paths", "GitHub reports a changed path that the local diff does not", [
        "changed_paths"
      ]);
    }
  }
  for (const [path, file] of diff.files) {
    if (!remote.has(path) && file.status !== "deleted") {
      throw new RangeRunError(
        "changed_paths",
        `local diff and GitHub changed files differ (${path} is not in the GitHub list)`,
        ["changed_paths"]
      );
    }
  }
}
async function resolveFindings(input, deps) {
  await deps.verifyHead();
  const diff = buildDiffModel(input.workspace, input.mergeBase, input.headSha);
  assertChangedPaths(diff, input.changedPaths);
  return input.findings.map(
    (finding) => resolveFinding({
      finding,
      diff,
      headSha: input.headSha,
      loadBlob: (file) => readHeadBlob(input.workspace, input.headSha, file.path)
    })
  );
}

// src/main.ts
var RUN_VERSION = "0.0.0";
var skillNameSchema = pipe(
  string(),
  check(
    (value) => value.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+){0,63}$/.test(value),
    "must match ^[a-z0-9]+(-[a-z0-9]+){0,63}$ within 64 characters"
  )
);
var modelSchema = pipe(
  string(),
  check((value) => /^[^\/\s]+\/[^\/\s#]+(#[^\s]+)?$/.test(value), "must be provider/model with an optional #variant")
);
var githubTokenSchema = pipe(string(), minLength(1));
function optionalTrimmed(defaultValue) {
  return optional(pipe(string(), trim()), defaultValue);
}
function booleanInput(defaultValue) {
  return pipe(
    optionalTrimmed(defaultValue),
    check((raw) => raw === "true" || raw === "false", 'must be exactly "true" or "false"'),
    transform((raw) => raw === "true")
  );
}
function numberInput(defaultValue, min, max, integer2) {
  return pipe(
    optionalTrimmed(defaultValue),
    check((raw) => raw.length > 0 && Number.isFinite(Number(raw)), "must be a finite number"),
    transform((raw) => Number(raw)),
    check(
      (value) => (!integer2 || Number.isInteger(value)) && value >= min && value <= max,
      `must be ${integer2 ? "an integer" : "a number"} in ${min}..${max}`
    )
  );
}
var actionInputsSchema = object({
  skill: skillNameSchema,
  model: modelSchema,
  dryRun: booleanInput("false"),
  githubToken: githubTokenSchema,
  jevModel: optional(picklist(["jev-1.13-free", "jev-1.13"]), "jev-1.13-free"),
  supportedThreshold: numberInput("0.7", 0, 1, false),
  commentWorthyThreshold: numberInput("0.6", 0, 1, false),
  timeoutSeconds: numberInput("600", 1, 3600, true),
  maxFindings: numberInput("100", 1, 1e3, true)
});
var actionInputEnvNames = {
  skill: "INPUT_SKILL",
  model: "INPUT_MODEL",
  dryRun: "INPUT_DRY-RUN",
  githubToken: "INPUT_GITHUB-TOKEN",
  jevModel: "INPUT_JEV-MODEL",
  supportedThreshold: "INPUT_SUPPORTED-THRESHOLD",
  commentWorthyThreshold: "INPUT_COMMENT-WORTHY-THRESHOLD",
  timeoutSeconds: "INPUT_TIMEOUT-SECONDS",
  maxFindings: "INPUT_MAX-FINDINGS"
};
var ActionInputError = class extends Error {
  fields;
  constructor(fields) {
    super(`Invalid Action inputs: ${fields.join(", ")}`);
    this.name = "ActionInputError";
    this.fields = fields;
  }
};
function readActionInputs(env) {
  const parsed = safeParse(actionInputsSchema, {
    skill: env["INPUT_SKILL"],
    model: env["INPUT_MODEL"],
    dryRun: env["INPUT_DRY-RUN"],
    githubToken: env["INPUT_GITHUB-TOKEN"],
    jevModel: env["INPUT_JEV-MODEL"],
    supportedThreshold: env["INPUT_SUPPORTED-THRESHOLD"],
    commentWorthyThreshold: env["INPUT_COMMENT-WORTHY-THRESHOLD"],
    timeoutSeconds: env["INPUT_TIMEOUT-SECONDS"],
    maxFindings: env["INPUT_MAX-FINDINGS"]
  });
  if (!parsed.success) {
    const names = parsed.issues.map((issue) => {
      const key = issue.path?.[0]?.key;
      return typeof key === "string" ? actionInputEnvNames[key] : "INPUT_?";
    });
    throw new ActionInputError([...new Set(names)]);
  }
  return parsed.output;
}
var requiredEnvironmentNames = ["GITHUB_EVENT_PATH", "RUNNER_TEMP", "GITHUB_OUTPUT", "GITHUB_REPOSITORY"];
var EnvironmentError = class extends Error {
  fields;
  constructor(fields) {
    super(`Missing required environment variables: ${fields.join(", ")}`);
    this.name = "EnvironmentError";
    this.fields = fields;
  }
};
function readRunnerEnvironment(env) {
  const missing = requiredEnvironmentNames.filter((name) => (env[name] ?? "").trim().length === 0);
  if (missing.length > 0) {
    throw new EnvironmentError([...missing]);
  }
  return {
    eventPath: env["GITHUB_EVENT_PATH"],
    runnerTemp: env["RUNNER_TEMP"],
    outputPath: env["GITHUB_OUTPUT"],
    repository: env["GITHUB_REPOSITORY"],
    workspace: env["GITHUB_WORKSPACE"] ?? process.cwd()
  };
}
function readJevToken(env) {
  const token = (env["OPENCODE_API_KEY"] ?? "").trim();
  if (token.length === 0) {
    throw new EnvironmentError(["OPENCODE_API_KEY"]);
  }
  return token;
}
var shaSchema2 = pipe(string(), regex(/^[0-9a-f]{40}$/i));
var fullNameSchema = pipe(string(), minLength(1));
var pullRequestEventSchema = object({
  action: picklist(["opened", "synchronize", "reopened", "ready_for_review"]),
  number: pipe(number(), finite(), integer(), minValue(1)),
  pull_request: object({
    draft: optional(boolean(), false),
    head: object({
      sha: shaSchema2,
      repo: object({ full_name: fullNameSchema })
    }),
    base: object({ sha: shaSchema2 })
  }),
  repository: object({
    full_name: fullNameSchema,
    private: optional(boolean())
  })
});
var EventError = class extends Error {
  fields;
  constructor(fields) {
    super(`Invalid GitHub event payload: ${fields.join(", ")}`);
    this.name = "EventError";
    this.fields = fields;
  }
};
function parsePullRequestEvent(json) {
  const parsed = safeParse(pullRequestEventSchema, json);
  if (!parsed.success) {
    const fields = parsed.issues.map((issue) => {
      const path = issue.path?.map((item) => String(item.key)).join(".");
      return path && path.length > 0 ? path : "event";
    });
    throw new EventError([...new Set(fields)]);
  }
  return parsed.output;
}
async function readEventFile(eventPath) {
  let text;
  try {
    text = await readFile2(eventPath, "utf8");
  } catch {
    throw new EventError(["GITHUB_EVENT_PATH"]);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EventError(["JSON"]);
  }
  return parsePullRequestEvent(json);
}
function isSameRepository(event) {
  return event.pull_request.head.repo.full_name === event.repository.full_name;
}
function buildReviewContext(inputs, event) {
  return {
    repository: event.repository.full_name,
    pullNumber: event.number,
    baseSha: event.pull_request.base.sha.toLowerCase(),
    headSha: event.pull_request.head.sha.toLowerCase(),
    skill: inputs.skill,
    model: inputs.model,
    thresholds: {
      supported: inputs.supportedThreshold,
      commentWorthy: inputs.commentWorthyThreshold
    },
    limits: {
      timeoutSeconds: inputs.timeoutSeconds,
      maxFindings: inputs.maxFindings
    }
  };
}
function dedupePublishables(publishables) {
  const firstByKey = /* @__PURE__ */ new Map();
  const unique = [];
  const duplicates = [];
  for (const finding of publishables) {
    const key = [
      finding.commitId.toLowerCase(),
      finding.path,
      finding.startLine,
      finding.endLine,
      finding.side,
      finding.severity,
      finding.title,
      finding.body
    ].join("\0");
    const first = firstByKey.get(key);
    if (first !== void 0) {
      duplicates.push({ finding, duplicateOf: first });
      continue;
    }
    firstByKey.set(key, finding.id);
    unique.push(finding);
  }
  return { unique, duplicates };
}
function planPublishEntries(publishables) {
  return publishables.map((finding) => ({
    findingId: finding.id,
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    severity: finding.severity,
    title: finding.title,
    payload: buildInlinePayload(finding),
    stage: "planned",
    commentId: null,
    url: null,
    ambiguous: false
  }));
}
function publishFailureDetail(error) {
  if (error instanceof HeadChangedError) {
    return { message: "PR head changed before posting the next comment", fields: ["head.sha"], ambiguous: false };
  }
  if (error instanceof GitHubError) {
    return { message: error.message, fields: error.fields, ambiguous: error.status === 0 };
  }
  return { message: "unexpected publisher failure", fields: [], ambiguous: false };
}
async function publishFindings(options, transport) {
  const entries = planPublishEntries(options.publishables);
  if (options.dryRun) {
    return { entries, posted: 0, failure: null };
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const fail = (step, error) => {
      for (let pending = index; pending < entries.length; pending += 1) {
        entries[pending].stage = "unposted";
      }
      const detail = publishFailureDetail(error);
      entries[index].ambiguous = detail.ambiguous;
      return {
        entries,
        posted: index,
        failure: {
          class: "mid-run failure",
          step,
          findingId: entry.findingId,
          message: detail.message,
          fields: detail.fields,
          ambiguous: detail.ambiguous
        }
      };
    };
    try {
      await transport.verifyHead();
    } catch (error) {
      return fail("head_recheck", error);
    }
    try {
      const posted = await transport.postComment(entry.payload);
      entry.stage = "posted";
      entry.commentId = posted.id;
      entry.url = posted.url;
    } catch (error) {
      return fail("post", error);
    }
  }
  return { entries, posted: entries.length, failure: null };
}
function formatDryRunPlan(entries, skipped) {
  return JSON.stringify({
    stage: "dry-run",
    publishables: entries.map((entry) => ({ findingId: entry.findingId, payload: entry.payload })),
    skipped: skipped.map((finding) => ({ id: finding.id, stage: finding.stage, reason: finding.reason }))
  });
}
function defaultPipelineDependencies(options = {}) {
  const githubOptions = { baseUrl: options.githubBaseUrl, fetchImpl: options.githubFetchImpl };
  return {
    prepareReview: (context, token, workspace, signal) => prepareReviewContext(
      { context, token, workspace, signal },
      { baseUrl: options.githubBaseUrl, fetchImpl: options.githubFetchImpl }
    ),
    produceFindings: (prepared, options2) => runFindingProducer({
      runnerTemp: options2.runnerTemp,
      prepared,
      model: options2.model,
      timeoutMs: options2.timeoutMs,
      maxFindings: options2.maxFindings,
      parentEnv: options2.parentEnv,
      protectedValues: options2.protectedValues,
      signal: options2.signal
    }),
    resolveRanges: (options2) => resolveFindings(
      {
        workspace: options2.prepared.workspace,
        mergeBase: options2.prepared.mergeBase,
        headSha: options2.context.headSha,
        changedPaths: options2.prepared.changedPaths,
        findings: options2.findings
      },
      {
        verifyHead: async () => {
          try {
            await verifyHeadCurrent(
              options2.token,
              options2.context.repository,
              options2.context.pullNumber,
              options2.context.headSha,
              { signal: options2.signal, ...githubOptions }
            );
          } catch (error) {
            if (error instanceof HeadChangedError) {
              throw new RangeRunError("head_changed", "PR head changed before range resolution", ["head.sha"]);
            }
            if (error instanceof GitHubError) {
              throw new RangeRunError("github", `verifying the PR head failed: ${error.message}`, error.fields);
            }
            throw error;
          }
        }
      }
    ),
    validateFindings: (stage) => validateResolvedFindings(stage, {
      jevClient: options.jevClient ?? createJevClient({ token: stage.jevToken, model: stage.jevModel })
    }),
    publishFindings: (stage) => publishFindings(stage, {
      verifyHead: async () => {
        await verifyHeadCurrent(
          stage.token,
          stage.context.repository,
          stage.context.pullNumber,
          stage.context.headSha,
          { signal: stage.signal, ...githubOptions }
        );
      },
      postComment: (payload) => postInlineComment(
        stage.token,
        stage.context.repository,
        stage.context.pullNumber,
        payload,
        { signal: stage.signal, ...githubOptions }
      )
    })
  };
}
function skippedGateOutcome(input) {
  return {
    finding: input.finding,
    range: input.range,
    stage: "skipped",
    validation: input.validation,
    jevCalls: input.jevCalls,
    rangeRetryUsed: input.rangeRetryUsed,
    reason: input.reason,
    publishable: null
  };
}
async function validateResolvedFinding(input) {
  const { finding, skillCriteria, thresholds, jevClient } = input;
  const blob = readHeadBlob(input.workspace, input.headSha, input.range.path);
  if (blob.kind === "skipped") {
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: null,
      jevCalls: 0,
      rangeRetryUsed: false,
      reason: { code: blob.reason, message: blob.message }
    });
  }
  const evidence = buildJevEvidence({
    diff: input.diff,
    path: input.range.path,
    blobLines: blob.lines,
    range: input.range
  });
  const first = await jevClient.validateFinding({ finding, resolved: input.range, skillCriteria, evidence, signal: input.signal });
  if (first.kind === "evidence_overflow") {
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: null,
      jevCalls: 0,
      rangeRetryUsed: false,
      reason: { code: "evidence_overflow", message: gateSkipMessages.evidence_overflow }
    });
  }
  const firstGate = decideGate({ finding, resolved: input.range, validation: first.validation, thresholds, rangeRetryUsed: false });
  if (firstGate.kind === "publishable") {
    return {
      finding,
      range: input.range,
      stage: "publishable",
      validation: first.validation,
      jevCalls: 1,
      rangeRetryUsed: false,
      reason: null,
      publishable: firstGate.publishable
    };
  }
  if (firstGate.kind === "skip") {
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: first.validation,
      jevCalls: 1,
      rangeRetryUsed: false,
      reason: { code: firstGate.reason, message: firstGate.message }
    });
  }
  const correction = reResolveForCorrection({
    finding,
    previous: input.range,
    quality: firstGate.quality,
    diff: input.diff,
    blobLines: blob.lines,
    attempt: 0
  });
  if (correction.kind === "skipped") {
    return skippedGateOutcome({
      finding,
      range: input.range,
      validation: first.validation,
      jevCalls: 1,
      rangeRetryUsed: true,
      reason: { code: correction.reason, message: correction.message }
    });
  }
  const corrected = correction.range;
  const correctedEvidence = buildJevEvidence({
    diff: input.diff,
    path: corrected.path,
    blobLines: blob.lines,
    range: corrected
  });
  const second = await jevClient.validateFinding({ finding, resolved: corrected, skillCriteria, evidence: correctedEvidence, signal: input.signal });
  if (second.kind === "evidence_overflow") {
    return skippedGateOutcome({
      finding,
      range: corrected,
      validation: null,
      jevCalls: 1,
      rangeRetryUsed: true,
      reason: { code: "evidence_overflow", message: gateSkipMessages.evidence_overflow }
    });
  }
  const secondGate = decideGate({ finding, resolved: corrected, validation: second.validation, thresholds, rangeRetryUsed: true });
  if (secondGate.kind === "publishable") {
    return {
      finding,
      range: corrected,
      stage: "publishable",
      validation: second.validation,
      jevCalls: 2,
      rangeRetryUsed: true,
      reason: null,
      publishable: secondGate.publishable
    };
  }
  if (secondGate.kind === "skip") {
    return skippedGateOutcome({
      finding,
      range: corrected,
      validation: second.validation,
      jevCalls: 2,
      rangeRetryUsed: true,
      reason: { code: secondGate.reason, message: secondGate.message }
    });
  }
  return skippedGateOutcome({
    finding,
    range: corrected,
    validation: second.validation,
    jevCalls: 2,
    rangeRetryUsed: true,
    reason: { code: "range_retry_exhausted", message: gateSkipMessages.range_retry_exhausted }
  });
}
async function validateResolvedFindings(options, deps) {
  const resolved = options.resolutions.filter(
    (resolution) => resolution.kind === "resolved"
  );
  if (resolved.length === 0) {
    return [];
  }
  const diff = buildDiffModel(options.prepared.workspace, options.prepared.mergeBase, options.context.headSha);
  const outcomes = [];
  for (const resolution of resolved) {
    outcomes.push(
      await validateResolvedFinding({
        finding: resolution.finding,
        range: resolution.range,
        diff,
        workspace: options.prepared.workspace,
        headSha: options.context.headSha,
        skillCriteria: options.skillCriteria,
        thresholds: options.context.thresholds,
        jevClient: deps.jevClient,
        signal: options.signal
      })
    );
  }
  return outcomes;
}
function stageForFailure(kind) {
  switch (kind) {
    case "github":
    case "head_changed":
    case "workspace":
    case "changed_paths":
    case "skill":
      return "context";
    case "config":
      return "config";
    case "spawn":
    case "timeout":
    case "cancelled":
    case "producer":
      return "producer";
    case "ndjson_missing":
    case "ndjson_corrupt":
    case "ndjson_too_large":
    case "limit_exceeded":
      return "results";
  }
}
function failure(stage, fields, message) {
  return { code: 1, error: { class: "run_error", stage, message, fields } };
}
var duplicateFindingMessage = "\u540C\u4E00invocation\u5185\u306E\u5B8C\u5168\u4E00\u81F4finding\u306E\u305F\u3081\u3001\u5148\u306B\u691C\u51FA\u3055\u308C\u305F\u6307\u6458\u3078\u7D71\u5408\u3057\u307E\u3057\u305F\u3002";
function buildRunArtifacts(input) {
  const { produced, resolutions, gateOutcomes, dedup, publish } = input;
  if (resolutions.length !== produced.findings.length) {
    throw new Error("range resolution count does not match the accepted findings");
  }
  const resolvedCount = resolutions.filter((resolution) => resolution.kind === "resolved").length;
  if (resolvedCount !== gateOutcomes.length) {
    throw new Error("gate outcome count does not match the resolved findings");
  }
  const gateById = new Map(gateOutcomes.map((outcome) => [outcome.finding.id, outcome]));
  if (gateById.size !== gateOutcomes.length) {
    throw new Error("duplicate gate outcomes");
  }
  const duplicateById = new Map(dedup.duplicates.map((duplicate) => [duplicate.finding.id, duplicate.duplicateOf]));
  const entryByFindingId = new Map(publish.entries.map((entry) => [entry.findingId, entry]));
  const skippedByRange = resolutions.filter((resolution) => resolution.kind === "skipped").length;
  const skippedByGate = gateOutcomes.filter((outcome) => outcome.stage === "skipped").length;
  const counts = {
    accepted: produced.findings.length,
    publishable: dedup.unique.length,
    published: publish.posted,
    skipped: produced.rejected.length + skippedByRange + skippedByGate + dedup.duplicates.length,
    deduped: dedup.duplicates.length
  };
  const resultPath = join2(input.runnerTemp, "review-result.json");
  const findings = produced.findings.map((finding, index) => {
    const resolution = resolutions[index];
    const base = {
      id: finding.id,
      path: finding.path,
      severity: finding.severity,
      title: finding.title
    };
    if (resolution.kind === "skipped") {
      return {
        ...base,
        stage: "skipped",
        transitions: [{ stage: "accepted" }, { stage: "skipped" }],
        reason: { code: resolution.reason, message: resolution.message },
        range: null,
        validation: null,
        jevCalls: 0,
        retryUsed: false,
        publish: null
      };
    }
    const outcome = gateById.get(finding.id);
    if (outcome === void 0) {
      throw new Error("resolved finding is missing a gate outcome");
    }
    const transitions = [{ stage: "accepted" }, { stage: "resolved" }];
    if (outcome.validation !== null) {
      transitions.push({ stage: "validated" });
    }
    const duplicateOf = duplicateById.get(finding.id);
    if (outcome.stage === "publishable" && duplicateOf !== void 0) {
      transitions.push({ stage: "skipped" });
      return {
        ...base,
        stage: "skipped",
        transitions,
        reason: { code: "duplicate_finding", message: duplicateFindingMessage },
        range: outcome.range,
        validation: outcome.validation,
        jevCalls: outcome.jevCalls,
        retryUsed: outcome.rangeRetryUsed,
        publish: null,
        duplicateOf
      };
    }
    transitions.push({ stage: outcome.stage });
    let publishRecord = null;
    if (outcome.stage === "publishable") {
      const entry = entryByFindingId.get(finding.id);
      if (entry === void 0) {
        throw new Error("publishable finding is missing a publisher entry");
      }
      transitions.push({ stage: entry.stage });
      publishRecord = {
        stage: entry.stage,
        commentId: entry.commentId,
        url: entry.url,
        ambiguous: entry.ambiguous
      };
    }
    return {
      ...base,
      stage: outcome.stage,
      transitions,
      reason: outcome.reason,
      range: outcome.range,
      validation: outcome.validation,
      jevCalls: outcome.jevCalls,
      retryUsed: outcome.rangeRetryUsed,
      publish: publishRecord
    };
  });
  const result = {
    runVersion: RUN_VERSION,
    status: input.status,
    dryRun: input.dryRun,
    repository: input.prepared.context.repository,
    pullNumber: input.prepared.context.pullNumber,
    skill: input.prepared.context.skill,
    model: input.prepared.context.model,
    baseSha: input.prepared.context.baseSha,
    headSha: input.prepared.context.headSha,
    mergeBase: input.prepared.mergeBase,
    counts,
    dedup: {
      count: dedup.duplicates.length,
      entries: dedup.duplicates.map((duplicate) => ({
        findingId: duplicate.finding.id,
        duplicateOf: duplicate.duplicateOf
      }))
    },
    publish: { failure: publish.failure },
    publishables: publish.entries,
    findings,
    rejected: produced.rejected
  };
  return { result, counts, resultPath, findings };
}
async function writeRunArtifacts(input) {
  const artifacts = buildRunArtifacts(input);
  await writeFile2(artifacts.resultPath, `${JSON.stringify(artifacts.result, null, 2)}
`, "utf8");
  return artifacts;
}
async function appendOutputs(outputPath, counts, resultPath) {
  if (outputPath === null || outputPath.trim().length === 0) {
    return;
  }
  const outputs = [
    `accepted-count=${counts.accepted}`,
    `publishable-count=${counts.publishable}`,
    `published-count=${counts.published}`,
    `skipped-count=${counts.skipped}`,
    `result-path=${resultPath ?? ""}`
  ];
  try {
    await appendFile(outputPath, `${outputs.join("\n")}
`, "utf8");
  } catch {
  }
}
var ZERO_COUNTS = { accepted: 0, publishable: 0, published: 0, skipped: 0, deduped: 0 };
async function run(env, dependencies = defaultPipelineDependencies(), signal) {
  let outputPath = (env["GITHUB_OUTPUT"] ?? "").trim() || null;
  try {
    const inputs = readActionInputs(env);
    const environment = readRunnerEnvironment(env);
    outputPath = environment.outputPath;
    const jevToken = readJevToken(env);
    const event = await readEventFile(environment.eventPath);
    if (!isSameRepository(event)) {
      await appendOutputs(outputPath, ZERO_COUNTS, null);
      return failure(
        "repository",
        ["pull_request.head.repo.full_name"],
        "fork pull requests are not supported by this Action"
      );
    }
    const context = buildReviewContext(inputs, event);
    const prepared = await dependencies.prepareReview(context, inputs.githubToken, environment.workspace, signal);
    const produced = await dependencies.produceFindings(prepared, {
      runnerTemp: environment.runnerTemp,
      model: context.model,
      timeoutMs: context.limits.timeoutSeconds * 1e3,
      maxFindings: context.limits.maxFindings,
      parentEnv: env,
      protectedValues: [inputs.githubToken],
      signal
    });
    const resolutions = await dependencies.resolveRanges({
      context,
      prepared,
      token: inputs.githubToken,
      findings: produced.findings,
      signal
    });
    const gateOutcomes = await dependencies.validateFindings({
      context,
      prepared,
      resolutions,
      skillCriteria: produced.skillCriteria,
      jevModel: inputs.jevModel,
      jevToken,
      signal
    });
    const dedup = dedupePublishables(
      gateOutcomes.filter((outcome2) => outcome2.stage === "publishable" && outcome2.publishable !== null).map((outcome2) => outcome2.publishable)
    );
    const plan = { entries: planPublishEntries(dedup.unique), posted: 0, failure: null };
    let artifacts;
    try {
      artifacts = await writeRunArtifacts({
        runnerTemp: environment.runnerTemp,
        prepared,
        produced,
        resolutions,
        gateOutcomes,
        dedup,
        publish: plan,
        status: "staged",
        dryRun: inputs.dryRun
      });
    } catch {
      await appendOutputs(outputPath, ZERO_COUNTS, null);
      return failure("results", [], "failed to write the run result file");
    }
    if (inputs.dryRun) {
      console.log(
        formatDryRunPlan(
          plan.entries,
          artifacts.findings.filter((finding) => finding.stage === "skipped").map((finding) => ({ id: finding.id, stage: finding.stage, reason: finding.reason }))
        )
      );
      try {
        artifacts = await writeRunArtifacts({
          runnerTemp: environment.runnerTemp,
          prepared,
          produced,
          resolutions,
          gateOutcomes,
          dedup,
          publish: plan,
          status: "dry_run",
          dryRun: true
        });
      } catch {
        await appendOutputs(outputPath, ZERO_COUNTS, artifacts.resultPath);
        return failure("results", [], "failed to write the run result file");
      }
      await appendOutputs(outputPath, artifacts.counts, artifacts.resultPath);
      return { code: 0, context };
    }
    const outcome = await dependencies.publishFindings({
      context,
      publishables: dedup.unique,
      token: inputs.githubToken,
      dryRun: false,
      signal
    });
    const status = outcome.failure === null ? "success" : "publisher_error";
    try {
      artifacts = await writeRunArtifacts({
        runnerTemp: environment.runnerTemp,
        prepared,
        produced,
        resolutions,
        gateOutcomes,
        dedup,
        publish: outcome,
        status,
        dryRun: false
      });
    } catch {
      await appendOutputs(outputPath, ZERO_COUNTS, artifacts.resultPath);
      return failure("results", [], "failed to write the run result file after publishing");
    }
    await appendOutputs(outputPath, artifacts.counts, artifacts.resultPath);
    if (outcome.failure !== null) {
      return failure(
        "publisher",
        outcome.failure.fields,
        `publisher mid-run failure (${outcome.failure.step}): ${outcome.failure.message} (posted ${outcome.posted})`
      );
    }
    return { code: 0, context };
  } catch (error) {
    await appendOutputs(outputPath, ZERO_COUNTS, null);
    if (error instanceof ActionInputError) {
      return failure("input", error.fields, "invalid Action inputs");
    }
    if (error instanceof EnvironmentError) {
      return failure("environment", error.fields, "missing required environment variables");
    }
    if (error instanceof EventError) {
      return failure("event", error.fields, "invalid GitHub event payload");
    }
    if (error instanceof JevRunError) {
      return failure("jev", error.fields, error.message);
    }
    if (error instanceof RangeRunError) {
      return failure("context", error.fields, error.message);
    }
    if (error instanceof ReviewRunError) {
      return failure(stageForFailure(error.kind), error.fields, error.message);
    }
    return failure("pipeline", [], "unexpected run failure");
  }
}
async function main(env = process.env) {
  const result = await run(env);
  if (result.code !== 0) {
    console.error(JSON.stringify(result.error));
  }
  return result.code;
}
var invokedPath = process.argv[1];
if (invokedPath !== void 0 && pathToFileURL(invokedPath).href === import.meta.url) {
  process.exitCode = await main();
}
export {
  ActionInputError,
  EnvironmentError,
  EventError,
  RUN_VERSION,
  ZERO_COUNTS,
  appendOutputs,
  buildReviewContext,
  buildRunArtifacts,
  dedupePublishables,
  defaultPipelineDependencies,
  duplicateFindingMessage,
  formatDryRunPlan,
  isSameRepository,
  main,
  parsePullRequestEvent,
  publishFindings,
  pullRequestEventSchema,
  readActionInputs,
  readJevToken,
  readRunnerEnvironment,
  reportFindingTemplate,
  run,
  stageForFailure,
  validateResolvedFindings,
  writeRunArtifacts
};
