/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AnnotationEditorType,
  AnnotationFlag,
  AnnotationMode,
  bytesToString,
  OPS,
  stringToBytes,
} from "../../src/shared/util.js";
import { assemblePdf, buildGetDocumentParams } from "./test_utils.js";
import { getDocument } from "../../src/display/api.js";

describe("api flattening", function () {
  function addSignatureEditor(annotationStorage) {
    annotationStorage.setValue("pdfjs_internal_editor_0", {
      annotationType: AnnotationEditorType.SIGNATURE,
      isSignature: true,
      areContours: false,
      color: [255, 0, 0],
      thickness: 1,
      pageIndex: 0,
      rect: [12, 34, 56, 78],
      rotation: 0,
      structTreeParentId: null,
      lines: [[NaN, NaN, NaN, NaN, 12, 34, 20, 40, 50, 70, 56, 78]],
    });
  }

  function addInkEditor(annotationStorage, extra) {
    annotationStorage.setValue("pdfjs_internal_editor_0", {
      annotationType: AnnotationEditorType.INK,
      color: [255, 0, 0],
      thickness: 1,
      opacity: 1,
      paths: {
        lines: [[NaN, NaN, NaN, NaN, 12, 34, 20, 40, 50, 70, 56, 78]],
        points: [[12, 34, 20, 40, 50, 70, 56, 78]],
      },
      pageIndex: 0,
      rect: [12, 34, 56, 78],
      rotation: 0,
      structTreeParentId: null,
      ...extra,
    });
  }

  // A page with the given content, and a stamp drawing "Hello" at (10, 10).
  function buildStampedPagePdf(content) {
    const appearance = "BT /F1 10 Tf (Hello) Tj ET";
    return assemblePdf([
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R " +
        "/OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >> >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] " +
        "/Resources << /Font << /F1 8 0 R >> /Properties << /OC1 6 0 R >> >> " +
        "/Contents 4 0 R /Annots [5 0 R] >>\nendobj\n",
      `4 0 obj\n<< /Length ${content.length} >>\n` +
        `stream\n${content}\nendstream\nendobj\n`,
      "5 0 obj\n<< /Type /Annot /Subtype /Stamp /F 4 " +
        "/Rect [10 10 60 60] /AP << /N 7 0 R >> >>\nendobj\n",
      "6 0 obj\n<< /Type /OCG /Name (Hidden) >>\nendobj\n",
      "7 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] " +
        "/Resources << /Font << /F1 8 0 R >> >> " +
        `/Length ${appearance.length} >>\n` +
        `stream\n${appearance}\nendstream\nendobj\n`,
      "8 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n" +
        "endobj\n",
    ]);
  }

  // A page with the given annotations, each drawing its name.
  function buildAnnotatedPagePdf(annotations) {
    const annots = annotations.map((_, i) => `${2 * i + 5} 0 R`).join(" ");
    const objects = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] " +
        `/Annots [${annots}] >>\nendobj\n`,
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n" +
        "endobj\n",
    ];
    for (const [i, [name, entries]] of annotations.entries()) {
      const appearance = `BT /F1 10 Tf (${name}) Tj ET`;
      objects.push(
        `${2 * i + 5} 0 obj\n<< /Type /Annot ${entries} ` +
          `/Rect [0 ${20 * i} 100 ${20 * i + 20}] ` +
          `/AP << /N ${2 * i + 6} 0 R >> >>\nendobj\n`,
        `${2 * i + 6} 0 obj\n<< /Type /XObject /Subtype /Form ` +
          "/BBox [0 0 100 20] /Resources << /Font << /F1 4 0 R >> >> " +
          `/Length ${appearance.length} >>\n` +
          `stream\n${appearance}\nendstream\nendobj\n`
      );
    }
    return assemblePdf(objects);
  }

  describe("saveDocument", function () {
    it("write a new signature, save the pdf flattened and check that it's drawn in the page content", async function () {
      let loadingTask = getDocument(buildGetDocumentParams("empty.pdf"));
      let pdfDoc = await loadingTask.promise;
      addSignatureEditor(pdfDoc.annotationStorage);

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      const savedString = bytesToString(data);
      expect(savedString).toContain("q 1 0 0 1 0 0 cm /FlatAnnot0 Do Q");

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

      const { fnArray } = await page.getOperatorList({
        annotationMode: AnnotationMode.DISABLE,
      });
      expect(fnArray).toContain(OPS.paintFormXObjectBegin);
      expect(fnArray).toContain(OPS.constructPath);

      await loadingTask.destroy();
    });

    it("saveDocument preserves form fields with non-form annotations flattened (saved and pending annotations)", async function () {
      for (const saveFirst of [false, true]) {
        let loadingTask = getDocument(buildGetDocumentParams("evaljs.pdf"));
        let pdfDoc = await loadingTask.promise;
        const value = "Hello World";

        pdfDoc.annotationStorage.setValue("55R", { value });
        pdfDoc.annotationStorage.setValue("56R", { noPrint: true });
        pdfDoc.annotationStorage.setValue("30R", {
          noView: true,
          noPrint: true,
        });
        addSignatureEditor(pdfDoc.annotationStorage);

        if (saveFirst) {
          // Reload to flatten a saved annotation without storage edits.
          const saved = await pdfDoc.saveDocument();
          await loadingTask.destroy();
          loadingTask = getDocument({ data: saved });
          pdfDoc = await loadingTask.promise;
        }

        const options = { flatten: true };
        const data = await pdfDoc.saveDocument(options);
        await loadingTask.destroy();

        loadingTask = getDocument({ data });
        pdfDoc = await loadingTask.promise;
        const fields = await pdfDoc.getFieldObjects();
        expect(fields.size).toEqual(10);
        expect(fields.get("Text1")[0].value).toEqual(value);

        for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
          const page = await pdfDoc.getPage(pageNumber);
          const annotations = await page.getAnnotations({ intent: "any" });
          expect(annotations.length).toEqual(pageNumber === 1 ? 3 : 7);
          expect(annotations.every(({ subtype }) => subtype === "Widget"))
            .withContext(`Page ${pageNumber}`)
            .toBeTrue();

          if (pageNumber === 1) {
            expect(
              annotations.find(({ fieldName }) => fieldName === "Text1")
                .fieldValue
            ).toEqual(value);
            expect(
              annotations.find(({ fieldName }) => fieldName === "Text2")
                .annotationFlags & AnnotationFlag.PRINT
            ).toEqual(0);
          } else {
            expect(
              annotations.find(({ fieldName }) => fieldName === "Text4")
                .annotationFlags & AnnotationFlag.HIDDEN
            ).toEqual(AnnotationFlag.HIDDEN);
          }

          const { fnArray } = await page.getOperatorList({
            annotationMode: AnnotationMode.DISABLE,
          });
          // Only the signature is added to the page content.
          expect(
            fnArray.filter(fn => fn === OPS.paintFormXObjectBegin).length
          ).toEqual(pageNumber === 1 ? 1 : 0);
          const { items } = await page.getTextContent();
          expect(items.map(({ str }) => str)).not.toContain(value);
        }

        await loadingTask.destroy();
      }
    });

    it("saveDocument flattens non-form annotations for the display and print intents", async function () {
      for (const intent of ["display", "print"]) {
        const flags = [
          0,
          AnnotationFlag.PRINT,
          AnnotationFlag.PRINT | AnnotationFlag.NOVIEW,
          AnnotationFlag.PRINT | AnnotationFlag.HIDDEN,
        ];
        const data = assemblePdf([
          "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
          "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
          "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] " +
            "/Annots [5 0 R 6 0 R 7 0 R 8 0 R] >>\nendobj\n",
          "4 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] " +
            "/Length 15 >>\nstream\n0 0 10 10 re f\nendstream\nendobj\n",
          ...flags.map(
            (flag, i) =>
              `${i + 5} 0 obj\n<< /Type /Annot /Subtype /Stamp /F ${flag} ` +
              "/Rect [0 0 10 10] /AP << /N 4 0 R >> >>\nendobj\n"
          ),
        ]);
        let loadingTask = getDocument({ data });
        let pdfDoc = await loadingTask.promise;
        const options = { flatten: true, intent };
        const saved = await pdfDoc.saveDocument(options);
        await loadingTask.destroy();

        loadingTask = getDocument({ data: saved });
        pdfDoc = await loadingTask.promise;
        const page = await pdfDoc.getPage(1);
        const annotations = await page.getAnnotations({ intent: "any" });
        expect(
          annotations.map(({ annotationFlags }) => annotationFlags)
        ).toEqual([flags[intent === "print" ? 0 : 2], flags[3]]);
        const { fnArray } = await page.getOperatorList({
          annotationMode: AnnotationMode.DISABLE,
        });
        expect(
          fnArray.filter(fn => fn === OPS.paintFormXObjectBegin).length
        ).toEqual(2);
        await loadingTask.destroy();
      }
    });

    it("saveDocument flattens without writing the data of the removed annotations", async function () {
      const loadingTask = getDocument(buildGetDocumentParams("evaljs.pdf"));
      const pdfDoc = await loadingTask.promise;
      // A new annotation with a comment.
      addInkEditor(pdfDoc.annotationStorage, {
        popup: { contents: "Private note", deleted: false },
      });

      const options = { flatten: true };
      const data = await pdfDoc.saveDocument(options);
      await loadingTask.destroy();

      const savedString = bytesToString(data);
      expect(savedString).not.toContain("Private note");
    });

    it("saveDocument flattens without removing a file attachment", async function () {
      let loadingTask = getDocument(
        buildGetDocumentParams("annotation-fileattachment.pdf")
      );
      let pdfDoc = await loadingTask.promise;

      const options = { flatten: true };
      const data = await pdfDoc.saveDocument(options);
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      const annotations = await page.getAnnotations({ intent: "any" });
      expect(
        annotations.map(({ subtype, file }) => [subtype, file?.filename])
      ).toEqual([["FileAttachment", "Test.txt"]]);

      // Its appearance is drawn in the page content.
      const { fnArray } = await page.getOperatorList({
        annotationMode: AnnotationMode.DISABLE,
      });
      expect(fnArray).toContain(OPS.paintFormXObjectBegin);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that the shared appearances and optional contents have one resource", async function () {
      const appearance = "0 0 10 10 re f";
      const stamp = (num, x) =>
        `${num} 0 obj\n<< /Type /Annot /Subtype /Stamp /F 4 ` +
        `/Rect [${x} 0 ${x + 10} 10] /OC 7 0 R /AP << /N 6 0 R >> >>\nendobj\n`;
      const loadingTask = getDocument({
        data: assemblePdf([
          "1 0 obj\n<< /Type /Catalog /Pages 2 0 R " +
            "/OCProperties << /OCGs [7 0 R] /D << >> >> >>\nendobj\n",
          "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
          "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] " +
            "/Annots [4 0 R 5 0 R] >>\nendobj\n",
          stamp(4, 0),
          stamp(5, 20),
          "6 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] " +
            `/Length ${appearance.length} >>\n` +
            `stream\n${appearance}\nendstream\nendobj\n`,
          "7 0 obj\n<< /Type /OCG /Name (Layer) >>\nendobj\n",
        ]),
      });
      const pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      const savedString = bytesToString(data);
      expect(savedString.match(/\/FlatAnnot0 Do/g).length).toEqual(2);
      expect(savedString.match(/\/OC \/FlatOC0 BDC/g).length).toEqual(2);
      expect(savedString).not.toContain("FlatAnnot1");
      expect(savedString).not.toContain("FlatOC1");

      await loadingTask.destroy();
    });

    it("save the pdf flattened with an invalid intent and check that the print one is used", async function () {
      let loadingTask = getDocument({
        // The stamp is printed but not viewed.
        data: buildAnnotatedPagePdf([["Stamp", "/Subtype /Stamp /F 36"]]),
      });
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true, intent: "foo" });
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      const { items } = await page.getTextContent();
      expect(items.map(({ str }) => str)).toEqual(["Stamp"]);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that a link is kept with its appearance drawn once", async function () {
      let loadingTask = getDocument({
        data: buildAnnotatedPagePdf([
          [
            "Link",
            "/Subtype /Link /F 4 /A << /S /URI /URI (https://example.com/) >>",
          ],
        ]),
      });
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      const annotations = await page.getAnnotations({ intent: "any" });
      expect(annotations.map(({ subtype, url }) => [subtype, url])).toEqual([
        ["Link", "https://example.com/"],
      ]);

      // Keep the link, but draw its text only once, in page content.
      const { items } = await page.getTextContent();
      expect(items.map(({ str }) => str)).toEqual(["Link"]);
      const { fnArray } = await page.getOperatorList();
      expect(fnArray.filter(fn => fn === OPS.showText).length).toEqual(1);

      await loadingTask.destroy();
    });

    it("save the pdf flattened without any modification and check that the annotations are drawn in the page content", async function () {
      let loadingTask = getDocument(buildGetDocumentParams("issue14438.pdf"));
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      // Popups are removed with their parents; ink without Rect is kept.
      const annotations = await page.getAnnotations({ intent: "any" });
      expect(annotations.map(({ id }) => id)).toEqual([
        "63R",
        "66R",
        "69R",
        "72R",
      ]);

      const { fnArray } = await page.getOperatorList({
        annotationMode: AnnotationMode.DISABLE,
      });
      expect(
        fnArray.filter(fn => fn === OPS.paintFormXObjectBegin).length
      ).toEqual(14);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that the popup of a drawn annotation is removed, even without parent", async function () {
      const appearance = "0 0 10 10 re f";
      let loadingTask = getDocument({
        data: assemblePdf([
          "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
          "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
          "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] " +
            "/Annots [4 0 R 5 0 R] >>\nendobj\n",
          "4 0 obj\n<< /Type /Annot /Subtype /Square /F 4 /Rect [0 0 10 10] " +
            "/Contents (Note) /Popup 5 0 R /AP << /N 6 0 R >> >>\nendobj\n",
          "5 0 obj\n<< /Type /Annot /Subtype /Popup /Rect [20 20 60 60] >>\n" +
            "endobj\n",
          "6 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] " +
            `/Length ${appearance.length} >>\n` +
            `stream\n${appearance}\nendstream\nendobj\n`,
        ]),
      });
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      expect(await pdfDoc.getAnnotArray(0)).toEqual([]);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that an annotation with an overflowing rectangle is kept", async function () {
      const appearance = "0 0 10 10 re f";
      const originalData = assemblePdf([
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] " +
          "/Annots [4 0 R] >>\nendobj\n",
        // The rectangle coordinate overflows to Infinity.
        "4 0 obj\n<< /Type /Annot /Subtype /Square /F 4 " +
          `/Rect [0 0 ${"9".repeat(400)} 10] /AP << /N 5 0 R >> >>\nendobj\n`,
        "5 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] " +
          `/Length ${appearance.length} >>\n` +
          `stream\n${appearance}\nendstream\nendobj\n`,
      ]);
      const loadingTask = getDocument({ data: originalData.slice() });
      const pdfDoc = await loadingTask.promise;

      // Keep the annotation rather than serialize nonfinite coordinates.
      const data = await pdfDoc.saveDocument({ flatten: true });
      expect(data).toEqual(originalData);

      await loadingTask.destroy();
    });

    it("save a pdf with an inline page flattened and check that the page is kept", async function () {
      const appearance = "0 0 10 10 re f";
      const originalData = assemblePdf([
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Count 1 /Kids [<< /Type /Page " +
          "/Parent 2 0 R /MediaBox [0 0 100 100] /Annots [3 0 R] >>] >>\n" +
          "endobj\n",
        "3 0 obj\n<< /Type /Annot /Subtype /Stamp /F 4 /Rect [0 0 10 10] " +
          "/AP << /N 4 0 R >> >>\nendobj\n",
        "4 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] " +
          `/Length ${appearance.length} >>\n` +
          `stream\n${appearance}\nendstream\nendobj\n`,
      ]);
      const loadingTask = getDocument({ data: originalData.slice() });
      const pdfDoc = await loadingTask.promise;

      // Flattening skips direct page dictionaries.
      const data = await pdfDoc.saveDocument({ flatten: true });
      expect(data).toEqual(originalData);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that an annotation which can't be read is kept", async function () {
      const appearance = "0 0 10 10 re f";
      const pdf = bytesToString(
        assemblePdf([
          "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
          "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
          "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] " +
            "/Annots [4 0 R 5 0 R] >>\nendobj\n",
          "4 0 obj\n<< /Type /Annot /Subtype /Stamp /F 7 0 R " +
            "/Rect [0 0 10 10] /AP << /N 6 0 R >> >>\nendobj\n",
          "5 0 obj\n<< /Type /Annot /Subtype /Stamp /F 4 /Rect [20 20 30 30] " +
            "/AP << /N 6 0 R >> >>\nendobj\n",
          "6 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] " +
            `/Length ${appearance.length} >>\n` +
            `stream\n${appearance}\nendstream\nendobj\n`,
          "7 0 obj\n4\nendobj\n",
        ])
      );
      // Point the flags object's xref entry into the PDF header.
      const offset = pdf.indexOf("7 0 obj").toString().padStart(10, "0");
      let loadingTask = getDocument({
        data: stringToBytes(
          pdf.replace(`${offset} 00000 n \n`, "0000000002 00000 n \n")
        ),
      });
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      expect(await pdfDoc.getAnnotArray(0)).toEqual(["4R"]);
      const page = await pdfDoc.getPage(1);
      const { fnArray } = await page.getOperatorList({
        annotationMode: AnnotationMode.DISABLE,
      });
      expect(
        fnArray.filter(fn => fn === OPS.paintFormXObjectBegin).length
      ).toEqual(1);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that an appearance without BBox or with an empty one is drawn as when rendering", async function () {
      for (const bbox of ["", "/BBox [0 0 0 0] "]) {
        const appearance = "1 0 0 rg 0 0 25 25 re f";
        let loadingTask = getDocument({
          data: assemblePdf([
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] " +
              "/Annots [4 0 R] >>\nendobj\n",
            "4 0 obj\n<< /Type /Annot /Subtype /Square /F 4 " +
              "/Rect [10 10 60 60] /AP << /N 5 0 R >> >>\nendobj\n",
            `5 0 obj\n<< /Type /XObject /Subtype /Form ${bbox}` +
              `/Length ${appearance.length} >>\n` +
              `stream\n${appearance}\nendstream\nendobj\n`,
          ]),
        });
        let pdfDoc = await loadingTask.promise;

        const data = await pdfDoc.saveDocument({ flatten: true });
        await loadingTask.destroy();

        // Translate without scaling; give the Form BBox the annotation's size.
        const savedString = bytesToString(data);
        expect(savedString).toContain("q 1 0 0 1 10 10 cm /FlatAnnot0 Do Q");
        expect(savedString).toContain("/BBox [0 0 50 50]");

        loadingTask = getDocument({ data });
        pdfDoc = await loadingTask.promise;
        const page = await pdfDoc.getPage(1);
        expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

        await loadingTask.destroy();
      }
    });

    it("save the pdf flattened and check that an annotation without appearance is drawn in the page content", async function () {
      let loadingTask = getDocument(
        buildGetDocumentParams("annotation-highlight-without-appearance.pdf")
      );
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      // The appearance and its nested Form XObject both have a BBox.
      const savedString = bytesToString(data);
      expect(savedString.match(/\/Subtype \/Form/g).length).toEqual(2);
      expect(savedString.match(/\/BBox/g).length).toEqual(2);

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

      const { fnArray } = await page.getOperatorList({
        annotationMode: AnnotationMode.DISABLE,
      });
      expect(
        fnArray.filter(fn => fn === OPS.paintFormXObjectBegin).length
      ).toEqual(2);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that the annotations are drawn from the initial graphics state", async function () {
      // Unmatched Qs, followed by unclosed saves, a clip, hidden marked content
      // and a text object.
      let loadingTask = getDocument({
        data: buildStampedPagePdf(
          "Q 1 0 0 1 100 100 cm Q BT /F1 10 Tf (Page) Tj ET " +
            "q 1 0 0 1 100 100 cm q 0 0 1 1 re W n /OC /OC1 BDC BT"
        ),
      });
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      const savedString = bytesToString(data);
      // The unmatched restores are replaced by spaces.
      expect(savedString).toContain(
        "\n  1 0 0 1 100 100 cm   BT /F1 10 Tf (Page) Tj ET q "
      );
      expect(savedString).toContain("stream\nq\n\nendstream");
      expect(savedString).toContain(
        "\nET\nEMC\nQ\nQ\nQ\nq 1 0 0 1 10 10 cm /FlatAnnot0 Do Q\n"
      );

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

      const { items } = await page.getTextContent({
        includeMarkedContent: true,
      });
      // Preserve page text placement; place the annotation outside the OCG.
      expect(items.map(({ type, str }) => type ?? str)).toEqual([
        "Page",
        "beginMarkedContentProps",
        "endMarkedContent",
        "Hello",
      ]);
      expect(items[0].transform).toEqual([10, 0, 0, 10, 100, 100]);
      expect(items[3].transform).toEqual([10, 0, 0, 10, 10, 10]);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that the unmatched restores around an inline image are removed", async function () {
      let loadingTask = getDocument({
        data: buildStampedPagePdf(
          "Q 1 0 0 1 100 100 cm Q BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q " +
            "BT /F1 10 Tf (Page) Tj ET"
        ),
      });
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      expect(bytesToString(data)).toContain(
        "\n  1 0 0 1 100 100 cm   BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI   BT "
      );

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

      const { items } = await page.getTextContent();
      expect(
        items.map(({ str, transform }) => [str, transform[4], transform[5]])
      ).toEqual([
        ["Page", 100, 100],
        ["Hello", 10, 10],
      ]);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that only the unmatched restores outside of the operands are removed", async function () {
      // Preserve matched Q and dictionary q/Q; remove the two unmatched Qs.
      let loadingTask = getDocument({
        data: buildStampedPagePdf(
          "q 1 0 0 1 0 0 cm Q Q /P <</MCID 0 /A q /B Q>> BDC [3] 0 d " +
            "BT /F1 10 Tf 100 100 Td (Page) Tj ET EMC Q"
        ),
      });
      let pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      expect(bytesToString(data)).toContain(
        "stream\nq 1 0 0 1 0 0 cm Q   /P <</MCID 0 /A q /B Q>> BDC [3] 0 d " +
          "BT /F1 10 Tf 100 100 Td (Page) Tj ET EMC  \nendstream"
      );

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

      const { items } = await page.getTextContent();
      expect(
        items.map(({ str, transform }) => [str, transform[4], transform[5]])
      ).toEqual([
        ["Page", 100, 100],
        ["Hello", 10, 10],
      ]);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that the annotations are kept when the page content can't be parsed", async function () {
      // EvaluatorPreprocessor rejects more than 33 operands before an operator.
      const originalData = buildStampedPagePdf(`${"0 ".repeat(34)}m`);
      const loadingTask = getDocument({ data: originalData.slice() });
      const pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      expect(data).toEqual(originalData);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that the page content streams in a direct or an indirect array are kept", async function () {
      for (const indirect of [false, true]) {
        const streamObject = (num, content, dict = "") =>
          `${num} 0 obj\n<< ${dict}/Length ${content.length} >>\n` +
          `stream\n${content}\nendstream\nendobj\n`;
        let loadingTask = getDocument({
          data: assemblePdf([
            "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
            "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
            "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] " +
              "/Resources << /Font << /F1 4 0 R >> >> " +
              `/Contents ${indirect ? "9 0 R" : "[5 0 R 6 0 R]"} ` +
              "/Annots [7 0 R] >>\nendobj\n",
            "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n" +
              "endobj\n",
            streamObject(5, "BT /F1 10 Tf 100 100 Td (Page1) Tj ET"),
            streamObject(6, "BT /F1 10 Tf 100 120 Td (Page2) Tj ET"),
            "7 0 obj\n<< /Type /Annot /Subtype /Stamp /F 4 " +
              "/Rect [10 10 60 60] /AP << /N 8 0 R >> >>\nendobj\n",
            streamObject(
              8,
              "BT /F1 10 Tf (Hello) Tj ET",
              "/Type /XObject /Subtype /Form /BBox [0 0 50 50] " +
                "/Resources << /Font << /F1 4 0 R >> >> "
            ),
            "9 0 obj\n[5 0 R 6 0 R]\nendobj\n",
          ]),
        });
        let pdfDoc = await loadingTask.promise;

        const data = await pdfDoc.saveDocument({ flatten: true });
        await loadingTask.destroy();

        // Keep both content streams between the save and appearance streams.
        expect(bytesToString(data)).toMatch(
          /\/Contents \[\d+ 0 R 5 0 R 6 0 R \d+ 0 R\]/
        );

        loadingTask = getDocument({ data });
        pdfDoc = await loadingTask.promise;
        const page = await pdfDoc.getPage(1);
        expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

        const { items } = await page.getTextContent();
        expect(
          items.map(({ str, transform }) => [str, transform[4], transform[5]])
        ).toEqual([
          ["Page1", 100, 100],
          ["Page2", 100, 120],
          ["Hello", 10, 10],
        ]);

        await loadingTask.destroy();
      }
    });

    it("save the pdf flattened and check that the resources of the content stream are kept", async function () {
      let loadingTask = getDocument(buildGetDocumentParams("issue18894.pdf"));
      let pdfDoc = await loadingTask.promise;
      // Stream-level /Resources take precedence over page resources.
      addSignatureEditor(pdfDoc.annotationStorage);

      const data = await pdfDoc.saveDocument({ flatten: true });
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      expect(await page.getAnnotations({ intent: "any" })).toEqual([]);

      const { fnArray } = await page.getOperatorList({
        annotationMode: AnnotationMode.DISABLE,
      });
      expect(
        fnArray.filter(fn => fn === OPS.paintFormXObjectBegin).length
      ).toEqual(3);

      await loadingTask.destroy();
    });

    it("save an unmodified pure xfa pdf flattened and check that it's unchanged", async function () {
      const loadingTask = getDocument(
        buildGetDocumentParams("xfa_issue14315.pdf", { enableXfa: true })
      );
      const pdfDoc = await loadingTask.promise;
      expect(pdfDoc.isPureXfa).toEqual(true);
      const originalData = await pdfDoc.getData();

      const data = await pdfDoc.saveDocument({ flatten: true });
      expect(data).toEqual(originalData);

      await loadingTask.destroy();
    });

    it("saveDocument uses edited annotation flags when flattening", async function () {
      let loadingTask = getDocument({
        data: buildAnnotatedPagePdf([
          ["Missing flags", "/Subtype /FreeText"],
          ["Screen only", "/Subtype /FreeText /F 0"],
          ["Printable", "/Subtype /FreeText /F 4"],
        ]),
      });
      let pdfDoc = await loadingTask.promise;
      for (let i = 0; i < 3; i++) {
        pdfDoc.annotationStorage.setValue(`pdfjs_internal_editor_${i}`, {
          annotationType: AnnotationEditorType.FREETEXT,
          id: `${2 * i + 5}R`,
          rect: [0, 20 * i, 100, 20 * i + 20],
          rotation: 0,
          fontSize: 10,
          color: [0, 0, 0],
          value: `Edited${i}`,
          pageIndex: 0,
        });
      }

      // Saving adds the print flag when /F is absent, but preserves /F 0.
      const options = { flatten: true };
      const data = await pdfDoc.saveDocument(options);
      await loadingTask.destroy();

      loadingTask = getDocument({ data });
      pdfDoc = await loadingTask.promise;
      const page = await pdfDoc.getPage(1);
      const annotations = await page.getAnnotations({ intent: "any" });
      expect(annotations.map(({ annotationFlags }) => annotationFlags)).toEqual(
        [0]
      );
      const { items } = await page.getTextContent();
      expect(items.map(({ str }) => str).filter(Boolean)).toEqual([
        "Edited0",
        "Edited2",
      ]);

      await loadingTask.destroy();
    });

    it("save the pdf flattened and check that the annotations which aren't rendered are kept", async function () {
      const originalData = buildAnnotatedPagePdf([
        // A highlight without QuadPoints.
        ["Highlight", "/Subtype /Highlight /F 4"],
        // An unknown annotation type with the Invisible flag.
        ["Unknown", "/Subtype /Unknown /F 5"],
      ]);
      const loadingTask = getDocument({ data: originalData.slice() });
      const pdfDoc = await loadingTask.promise;

      const data = await pdfDoc.saveDocument({ flatten: true });
      expect(data).toEqual(originalData);

      await loadingTask.destroy();
    });
  });
});
