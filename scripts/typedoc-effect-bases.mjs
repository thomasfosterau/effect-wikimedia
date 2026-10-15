// @ts-check
/**
 * Trims the members our classes inherit from Effect's base classes out of the
 * API reference, keeping the ones a consumer uses (#87, #99, #115).
 *
 * A `class X extends Context.Service<X, Shape>()(key) {}` inherits about 20
 * members from Effect (`key`, `of`, `use`, `pipe`, the symbol brands, …), and
 * a `class X extends Schema.TaggedError<X>()(tag, fields) {}` about 40 (the
 * schema statics, `Pipeable`, `Inspectable`, the `Error` and `YieldableError`
 * internals). TypeDoc renders each one with an "Inherited from" line that
 * prints the whole base-class expression, doc comments included, and resolves
 * shared symbols to whichever subclass it converted first, so one class's page
 * linked members and type parameters on another's (`Core.WikimediaClient`
 * showed `WikidataLookup.*`; `Core.RequestFailed` showed `InvalidQuery.*` and
 * `InvalidRequest.*`). `excludeExternals` can't fix it: it would also drop the
 * inherited members a consumer does use.
 *
 * So for each class on one of the `EFFECT_BASES`, this keeps the members
 * that base lists, re-homed onto the class (no "Inherited from" line, not
 * flagged external or inherited, defined where the class is), and removes the
 * rest of the inherited external members, the inherited constructor included
 * unless the base lists it. Effect's own reference documents the removed ones. Our own reflections are
 * untouched, so `typedoc.json`'s validation still covers every export and
 * every `{@link}` in their doc comments. Docgen fails (TypeDoc's CLI fails on
 * any logged error) if a base matches no class or a kept member is missing,
 * so an Effect or TypeDoc change can't silently stop the trimming or silently
 * drop documented members. It also fails if, after trimming, any class still
 * inherits more than `MAX_INHERITED_EXTERNALS` external members: that class is
 * on a base missing from `EFFECT_BASES` (a `Schema.Class`, `Schema.TaggedClass`
 * or `Schema.Error`, say), so its page would render the base's internals.
 */
import { Converter, ReflectionFlag, ReflectionKind } from "typedoc";

/** @typedef {import("typedoc").DeclarationReflection} Declaration */
/** @typedef {import("typedoc").ProjectReflection} Project */
/** @typedef {import("typedoc").SomeType} SomeType */

/**
 * An Effect base class: how TypeDoc records it, and which members to keep.
 *
 * @typedef {object} EffectBase
 * @property {string} recorded How TypeDoc records the base, for the error messages.
 * @property {string} issue The issue that added it, for the error messages.
 * @property {(cls: Declaration) => string[] | undefined} keep The `memberKey`s
 *   to keep on `cls`, or `undefined` when `cls` isn't built on this base.
 */

/**
 * Whether `type` is a reference to the `effect` export `qualifiedName`.
 *
 * @param {SomeType} type
 * @param {string} qualifiedName
 */
function isEffectReference(type, qualifiedName) {
  return (
    type.type === "reference" && type.package === "effect" && type.qualifiedName === qualifiedName
  );
}

/**
 * `extends Context.Service<…>()(…)`: TypeDoc records the base as Effect's
 * `ServiceClass.Shape`. Keeps the instance `Service` property, the shape a
 * consumer calls, where its documented methods (`getJson`, …) render.
 *
 * @param {Declaration} cls
 */
function contextServiceKeep(cls) {
  const extended = cls.extendedTypes ?? [];
  return extended.some((type) => isEffectReference(type, "ServiceClass.Shape"))
    ? ["Service"]
    : undefined;
}

/**
 * The member names of the object literal in `type`, when `type` is the
 * intersection `{ _tag: tag; …fields } & YieldableError<this>` TypeDoc records
 * for a `Schema.TaggedError` base (with `YieldableError` from `effect`), and
 * none otherwise.
 *
 * @param {SomeType} type
 * @returns {string[]}
 */
function taggedErrorFields(type) {
  if (type.type !== "intersection" || !type.types.some(isYieldableError)) return [];
  return type.types.flatMap(literalMemberNames);
}

/**
 * Whether `type` is a reference to Effect's `YieldableError`.
 *
 * @param {SomeType} type
 */
function isYieldableError(type) {
  return isEffectReference(type, "YieldableError");
}

/**
 * The member names of `type` if it is an object literal, and none otherwise.
 *
 * @param {SomeType} type
 * @returns {string[]}
 */
function literalMemberNames(type) {
  return type.type === "reflection"
    ? (type.declaration.children ?? []).map((member) => member.name)
    : [];
}

/**
 * `extends Schema.TaggedError<…>()(tag, fields)`, recognised by
 * `taggedErrorFields`. Keeps what a consumer of an error uses: the
 * constructor, `_tag` and the schema fields (the object literal's members),
 * `message`, and the static `makeEffect`.
 *
 * @param {Declaration} cls
 */
function taggedErrorKeep(cls) {
  const fields = (cls.extendedTypes ?? []).flatMap(taggedErrorFields);
  return fields.includes("_tag")
    ? ["constructor", ...fields, "message", "static makeEffect"]
    : undefined;
}

/** @type {readonly EffectBase[]} */
const EFFECT_BASES = [
  {
    recorded: "effect's `ServiceClass.Shape` (`Context.Service`)",
    issue: "#87",
    keep: contextServiceKeep,
  },
  {
    recorded:
      "an intersection with effect's `YieldableError` and a `_tag` literal (`Schema.TaggedError`)",
    issue: "#99",
    keep: taggedErrorKeep,
  },
];

/**
 * The most inherited external members a class may still have after trimming
 * before docgen fails (#115). Every class in today's surface has none: the
 * trimmed ones lose all but the members they keep, which are re-homed, and
 * the plain `Dumps.XmlPageReader` inherits nothing. An untrimmed Effect base
 * brings at least 14 (measured on effect 4.0.0: `Data.Error` 14,
 * `Data.TaggedError` 15, `Context.Service` 21, `Schema.Class` 29,
 * `Schema.TaggedClass` 30, `Schema.Error` 42, `Schema.TaggedError` 43), and
 * even a bare `extends Error` brings 11 (the lib's four instance members and
 * constructor, Node's three statics, and Effect's three `ErrorReporter`
 * symbols on the global `Error`). Five sits well below all of those while
 * leaving room for a plain class on a small non-Effect base.
 */
const MAX_INHERITED_EXTERNALS = 5;

/**
 * The key a member is kept by: its name, prefixed `static ` for a static.
 *
 * @param {Declaration} member
 */
function memberKey(member) {
  return member.flags.isStatic ? `static ${member.name}` : member.name;
}

/**
 * Whether `member` comes from Effect (or the TS lib) rather than our source:
 * an external inherited member, or the external constructor.
 *
 * @param {Declaration} member
 */
function isInheritedExternal(member) {
  return (
    member.flags.isExternal &&
    Boolean(member.inheritedFrom || member.kindOf(ReflectionKind.Constructor))
  );
}

/**
 * Presents a kept member as the class's own: drops the "Inherited from" line
 * (on the member and its signatures), clears the inherited and external flags
 * (which the default theme's filters hide), and points an external one's
 * "Defined in" at the class.
 *
 * @param {Declaration} member
 * @param {Declaration} cls
 */
function rehome(member, cls) {
  for (const reflection of [member, ...member.getAllSignatures()]) {
    delete reflection.inheritedFrom;
    if (reflection.flags.isExternal && cls.sources) reflection.sources = [...cls.sources];
    reflection.setFlag(ReflectionFlag.Inherited, false);
    reflection.setFlag(ReflectionFlag.External, false);
  }
}

/**
 * Keeps and re-homes `cls`'s members listed in `keep`, removes its other
 * inherited external members, and returns the keys in `keep` it lacks. A
 * member `cls` declares itself counts as kept.
 *
 * @param {Project} project
 * @param {Declaration} cls
 * @param {string[]} keep
 */
function trimClass(project, cls, keep) {
  // A copy: `removeReflection` splices `cls.children`.
  const members = [...(cls.children ?? [])];
  const isKept = (/** @type {Declaration} */ member) => keep.includes(memberKey(member));
  const isDropped = (/** @type {Declaration} */ member) =>
    !isKept(member) && isInheritedExternal(member);
  for (const member of members.filter(isKept)) rehome(member, cls);
  for (const member of members.filter(isDropped)) project.removeReflection(member);
  const present = new Set(members.map(memberKey));
  return keep.filter((key) => !present.has(key));
}

/**
 * The base `cls` is built on and the member keys to keep, if any.
 *
 * @param {Declaration} cls
 * @returns {{ cls: Declaration, base: EffectBase, keep: string[] } | undefined}
 */
function matchBase(cls) {
  for (const base of EFFECT_BASES) {
    const keep = base.keep(cls);
    if (keep) return { cls, base, keep };
  }
  return undefined;
}

/**
 * Trims a matched class, logging an error (which fails docgen) for each kept
 * member it lacks: Effect renamed or moved it, so its docs would silently
 * vanish. Returns the base, to record it as matched.
 *
 * @param {import("typedoc").Logger} logger
 * @param {Project} project
 * @param {{ cls: Declaration, base: EffectBase, keep: string[] }} match
 */
function trimMatch(logger, project, { cls, base, keep }) {
  for (const key of trimClass(project, cls, keep)) {
    logger.error(
      `typedoc-effect-bases: ${cls.getFriendlyFullName()} has no \`${key}\` member to keep; update the plugin (${base.issue}).`,
    );
  }
  return base;
}

/**
 * Logs an error (which fails docgen) for each base no class matched: Effect or
 * TypeDoc changed how it is recorded, so the plugin would silently stop
 * trimming that base's classes.
 *
 * @param {import("typedoc").Logger} logger
 * @param {Set<EffectBase>} matched
 */
function reportUnmatched(logger, matched) {
  for (const base of EFFECT_BASES.filter((base) => !matched.has(base))) {
    logger.error(
      `typedoc-effect-bases: no class extends ${base.recorded}; update or remove its entry in the plugin (${base.issue}).`,
    );
  }
}

/**
 * How many inherited external members `cls` has (see `isInheritedExternal`).
 *
 * @param {Declaration} cls
 */
function inheritedExternalCount(cls) {
  return (cls.children ?? []).filter(isInheritedExternal).length;
}

/**
 * Logs an error (which fails docgen) for each class that, after trimming,
 * still inherits more than `MAX_INHERITED_EXTERNALS` external members: it is
 * on an Effect base the plugin doesn't know, so its page renders that base's
 * internals.
 *
 * @param {import("typedoc").Logger} logger
 * @param {Project} project
 */
function reportUntrimmed(logger, project) {
  for (const reflection of project.getReflectionsByKind(ReflectionKind.Class)) {
    const cls = /** @type {Declaration} */ (reflection);
    const count = inheritedExternalCount(cls);
    if (count <= MAX_INHERITED_EXTERNALS) continue;
    logger.error(
      `typedoc-effect-bases: ${cls.getFriendlyFullName()} still inherits ${count} external members (more than ${MAX_INHERITED_EXTERNALS}), so its page renders its base's internals; add its base to \`EFFECT_BASES\` in the plugin, with the members a consumer uses (#115).`,
    );
  }
}

/**
 * Trims every class on one of the `EFFECT_BASES`, failing docgen if a class
 * lacks a kept member, a base matches no class, or a class still inherits
 * more than `MAX_INHERITED_EXTERNALS` external members.
 *
 * @param {import("typedoc").Logger} logger
 * @param {Project} project
 */
function trimEffectBases(logger, project) {
  /** @type {Set<EffectBase>} */
  const matched = new Set();
  for (const reflection of project.getReflectionsByKind(ReflectionKind.Class)) {
    const match = matchBase(/** @type {Declaration} */ (reflection));
    if (match) matched.add(trimMatch(logger, project, match));
  }
  reportUnmatched(logger, matched);
  reportUntrimmed(logger, project);
}

/**
 * Registers the converter hook with TypeDoc (the plugin entry point).
 *
 * @param {import("typedoc").Application} app
 */
export function load(app) {
  // Named, not inline: fallow names every anonymous arrow `<arrow>`, so a
  // health pin on one would cover them all (#108's review).
  const onResolveBegin = (/** @type {import("typedoc").Context} */ context) =>
    trimEffectBases(app.logger, context.project);
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, onResolveBegin);
}
