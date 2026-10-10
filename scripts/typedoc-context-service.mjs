// @ts-check
/**
 * Trims Effect's `Context.Service` machinery from the API reference (#87).
 *
 * A `class X extends Context.Service<X, Shape>()(key) {}` inherits about 20
 * members from Effect (`key`, `of`, `use`, `pipe`, `[iterator]`, the symbol
 * brands, …). TypeDoc renders each one with an "Inherited from" line that
 * prints the whole base-class expression, doc comments included, and resolves
 * the symbol-keyed ones to whichever `Context.Service` subclass it converted
 * first, so `Core.WikimediaClient` showed `WikidataLookup.*` attributions.
 * `excludeExternals` can't fix it: it drops the inherited `Service` property
 * too, which is where the documented methods (`getJson`, `getText`, …) render.
 *
 * So for each class whose base is `Context.Service`, this keeps the instance
 * `Service` property (the shape a consumer calls), re-homed onto the class,
 * and removes the rest of the inherited members and the `never`-taking
 * constructor. Effect's own reference documents the removed statics. Our own
 * reflections are untouched, so `typedoc.json`'s validation still covers every
 * export and every `{@link}` in the shape's doc comments.
 */
import { Converter, ReflectionFlag, ReflectionKind } from "typedoc";

/**
 * Whether `reflection` is a class declared as `extends Context.Service<…>()(…)`:
 * TypeDoc records that base as Effect's `ServiceClass.Shape`.
 *
 * @param {import("typedoc").DeclarationReflection} reflection
 */
function extendsContextService(reflection) {
  return (reflection.extendedTypes ?? []).some(
    (type) =>
      type.type === "reference" &&
      type.package === "effect" &&
      type.qualifiedName === "ServiceClass.Shape",
  );
}

/**
 * Registers the converter hook with TypeDoc (the plugin entry point).
 *
 * @param {import("typedoc").Application} app
 */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    const { project } = context;
    let matched = 0;
    for (const reflection of project.getReflectionsByKind(ReflectionKind.Class)) {
      const cls = /** @type {import("typedoc").DeclarationReflection} */ (reflection);
      if (!extendsContextService(cls)) continue;
      matched++;
      let kept = false;
      // A copy: `removeReflection` splices `cls.children` as this loop runs.
      for (const member of (cls.children ?? []).slice()) {
        const inherited =
          member.flags.isExternal &&
          (member.inheritedFrom || member.kindOf(ReflectionKind.Constructor));
        if (!inherited) continue;
        if (member.name === "Service" && !member.flags.isStatic) {
          delete member.inheritedFrom;
          member.setFlag(ReflectionFlag.Inherited, false);
          member.setFlag(ReflectionFlag.External, false);
          if (cls.sources) member.sources = [...cls.sources];
          kept = true;
          continue;
        }
        project.removeReflection(member);
      }
      // Effect renamed or moved the instance `Service` property: the shape's
      // documented methods would silently stop rendering.
      if (!kept) {
        app.logger.error(
          `typedoc-context-service: ${cls.getFriendlyFullName()} inherits no instance \`Service\` property; update the plugin (#87).`,
        );
      }
    }
    // Effect or TypeDoc changed how the base is recorded: without this the
    // plugin would silently stop trimming anything.
    if (matched === 0) {
      app.logger.error(
        "typedoc-context-service: no class extends effect's `ServiceClass.Shape`; update or remove the plugin (#87).",
      );
    }
  });
}
