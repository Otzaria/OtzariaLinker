export { CitationRun, runCitationsEngine, scoreOf, type CitationLibrary, type CitationsOptions } from "./engine";
export { AliasIndex, collectionOf, type CatalogBook, type Collection } from "./aliases";
export { buildHeadingsIndex, buildRefIndex, type RefLine, type Resolution, type TargetIndex } from "./resolve";
export { CitationScanner, mergeIbid, type Citation, type CitedUnit } from "./detect";
export { NamedUnitIndex, unitKindOf, unitsFromAltToc, type NamedUnit, type NamedUnitSource, type UnitKind } from "./named";
export { parseAddress, type AddrElem, type Address } from "./address";
export { citationTokens } from "./text";
export { numeralOf, strictValue } from "./numbers";
