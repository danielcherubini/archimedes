import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Virtuoso } from "react-virtuoso";

describe("Virtuoso setup in jsdom", () => {
  it("renders with Task 7 exact props in StrictMode", () => {
    render(
      <React.StrictMode>
        <Virtuoso
          data={[1, 2, 3]}
          firstItemIndex={99_990}
          alignToBottom
          initialTopMostItemIndex={{ index: "LAST", align: "end" }}
          followOutput={(atBottom) => (atBottom ? "auto" : false)}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          components={{
            Header: () => <div>Header</div>,
            Footer: () => <div>Footer</div>,
          }}
          context={{}}
          itemContent={(index, item) => (
            <div>
              Item {item} (idx {index})
            </div>
          )}
        />
      </React.StrictMode>,
    );

    expect(screen.getByText("Item 1 (idx 99990)")).toBeTruthy();
    expect(screen.getByText("Item 2 (idx 99991)")).toBeTruthy();
    expect(screen.getByText("Item 3 (idx 99992)")).toBeTruthy();
    expect(screen.getByText("Header")).toBeTruthy();
    expect(screen.getByText("Footer")).toBeTruthy();
  });
});
