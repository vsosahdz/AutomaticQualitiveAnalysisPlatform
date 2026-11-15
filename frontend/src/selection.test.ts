// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { pointToOffset, rangeToOffsets } from "./selection";

// Texto "Hola **mundo** bonito" con un resaltado en "**mundo**" (5..14):
// segmentos [0,5) "Hola ", [5,14) "**mundo**", [14,21) " bonito".
let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML =
    '<p id="v"><span data-start="0">Hola </span>' +
    '<mark data-start="5">**mundo**</mark>' +
    '<span data-start="14"> bonito</span></p>';
  root = document.getElementById("v") as HTMLElement;
});

function textOf(i: number): Text {
  return root.children[i].firstChild as Text;
}

describe("pointToOffset", () => {
  it("suma data-start y el desplazamiento en el nodo de texto", () => {
    expect(pointToOffset(textOf(1), 2, root)).toBe(7);
    expect(pointToOffset(textOf(2), 7, root)).toBe(21);
  });

  it("interpreta puntos sobre el elemento del segmento", () => {
    expect(pointToOffset(root.children[1], 0, root)).toBe(5);
    expect(pointToOffset(root.children[1], 1, root)).toBe(14);
  });

  it("interpreta puntos sobre el contenedor por índice de hijos", () => {
    expect(pointToOffset(root, 1, root)).toBe(5);
    expect(pointToOffset(root, 3, root)).toBe(21);
  });

  it("devuelve null fuera del visor", () => {
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    expect(pointToOffset(outside, 0, root)).toBeNull();
  });
});

describe("rangeToOffsets", () => {
  it("convierte una selección que cruza segmentos", () => {
    const range = document.createRange();
    range.setStart(textOf(0), 2); // "la "
    range.setEnd(textOf(2), 3); // " bo"
    expect(rangeToOffsets(range, root)).toEqual({ start: 2, end: 17 });
  });

  it("devuelve null con una selección vacía", () => {
    const range = document.createRange();
    range.setStart(textOf(1), 3);
    range.setEnd(textOf(1), 3);
    expect(rangeToOffsets(range, root)).toBeNull();
  });
});
