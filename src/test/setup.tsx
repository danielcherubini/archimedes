import { vi } from "vitest";

vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  function VirtuosoMockWrapper(props: any) {
    // Strip initialTopMostItemIndex before passing props to real Virtuoso
    // (in jsdom with VirtuosoMockContext, initialTopMostItemIndex causes 0 rows to render synchronously)
    const { initialTopMostItemIndex: _ignored, ...rest } = props;
    return (
      <actual.VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 40 }}>
        <actual.Virtuoso {...rest} />
      </actual.VirtuosoMockContext.Provider>
    );
  }
  return {
    ...actual,
    Virtuoso: VirtuosoMockWrapper,
  };
});

if (!Element.prototype.scrollBy) {
  Element.prototype.scrollBy = () => {};
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
