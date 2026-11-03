// Tests for the paged gallery's arithmetic (lib/gallery.ts).
//
//   npx tsx lib/gallery.test.mjs

import { galleryPageCount, galleryPageHref, parseGalleryPage } from './gallery.ts';

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.log(`  FAIL ${msg}`);
    failures++;
  }
}

console.log('galleryPageCount');
ok(galleryPageCount(0, 24) === 1, 'an empty gallery still has page 1');
ok(galleryPageCount(1, 24) === 1, 'one photo is one page');
ok(galleryPageCount(24, 24) === 1, 'exactly one full page is one page');
ok(galleryPageCount(25, 24) === 2, 'one over spills onto page 2');
ok(galleryPageCount(193, 24) === 9, '193 photos is nine pages');
ok(galleryPageCount(Number.NaN, 24) === 1, 'a non-number total falls back to one page');

console.log('galleryPageHref');
ok(galleryPageHref(1) === '/gallery', 'page 1 is plain /gallery');
ok(galleryPageHref(2) === '/gallery/2', 'page 2 is /gallery/2');

console.log('parseGalleryPage');
ok(parseGalleryPage('1') === 1, '"1" parses (the route redirects it)');
ok(parseGalleryPage('9') === 9, '"9" parses');
ok(parseGalleryPage('12') === 12, '"12" parses');
for (const bad of ['abc', '0', '-2', '2.5', '02', '', ' 3', '1e3', '9999999']) {
  ok(parseGalleryPage(bad) === null, `${JSON.stringify(bad)} is not a page`);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
