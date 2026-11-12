/**
 * Typed lookups over wikitext nodes for the tests: a refinement by `_tag`
 * that narrows to the node type, so a test reads a node's fields without a
 * type assertion (#224).
 *
 * @module tests/helpers/nodes
 */

import * as P from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";
import type { Node } from "../../src/wikitext/index.ts";

/** The node type a `_tag` names. */
export type NodeOf<T extends Node["_tag"]> = Extract<Node, { readonly _tag: T }>;

/** A refinement to the node type `tag` names. */
export const isNode =
  <T extends Node["_tag"]>(tag: T) =>
  (node: Node): node is NodeOf<T> =>
    P.isTagged(node, tag);

/** The first node in `nodes` tagged `tag`, failing the test when there is none. */
export const firstNode = <T extends Node["_tag"]>(nodes: readonly Node[], tag: T): NodeOf<T> =>
  Option.match(Arr.findFirst(nodes, isNode(tag)), {
    onNone: () => expect.unreachable(`no ${tag} node`),
    onSome: (node) => node,
  });
