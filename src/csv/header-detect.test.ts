import { describe, expect, it } from "vitest";

import { detectHeader, syntheticHeaders } from "./header-detect";

const rows = (text: string): string[][] => text.split("\n").map((line) => line.split(","));

describe("detectHeader", () => {
  it("treats text over numeric columns as a header", () => {
    expect(detectHeader(rows("id,name,age\n1,Ann,34\n2,Bo,41\n3,Cy,29"))).toBe(true);
  });

  it("treats a numeric, duplicated first row as data", () => {
    expect(
      detectHeader(
        rows(
          "1347445,MALOKANE CONSALIA,NAWE,FEMALE,Registered,PENDING RENEWAL,D,PENDING RENEWAL,\n1347446,SOMEONE ELSE,NAWE,MALE,Registered,ACTIVE,D,ACTIVE,\n1347447,THIRD PERSON,NAWE,FEMALE,Registered,ACTIVE,D,ACTIVE,",
        ),
      ),
    ).toBe(false);
  });

  it("treats dates, phones and emails in the first row as data", () => {
    expect(detectHeader(rows("2024-01-31,a@b.co,x\n2024-02-01,c@d.co,y\n2024-02-02,e@f.co,z"))).toBe(false);
    expect(detectHeader(rows("27609897840,YOLANDA ZITO,ZA\n27609897841,ANOTHER NAME,ZA\n27609897842,THIRD NAME,ZA"))).toBe(false);
  });

  it("keeps the header on a tie, with one row, and with no rows", () => {
    expect(detectHeader(rows("name,city\nAnn,Cape Town\nBo,Durban"))).toBe(true);
    expect(detectHeader(rows("Ann,Cape Town\nBo,Durban"))).toBe(true);
    expect(detectHeader(rows("id,name"))).toBe(true);
    expect(detectHeader([])).toBe(true);
  });

  it("generates numbered column names", () => {
    expect(syntheticHeaders(3)).toEqual(["Column 1", "Column 2", "Column 3"]);
  });
});
