# Changelog

## [1.2.0](https://github.com/derekwinters/roadtrip-backend/compare/v1.1.0...v1.2.0) (2026-10-19)


### Features

* **ai:** adopt shared ai-skills bundles (dev agent, skills, self-updater, pr-title-lint) ([#98](https://github.com/derekwinters/roadtrip-backend/issues/98)) ([4c971d3](https://github.com/derekwinters/roadtrip-backend/commit/4c971d33b4de0f39dfa1e09156f9cf0104d4b3cc))
* **bingo:** accept Canadian provinces and territories as plates ([#159](https://github.com/derekwinters/roadtrip-backend/issues/159)) ([b3301ce](https://github.com/derekwinters/roadtrip-backend/commit/b3301ceb5a946b64da4fedf366549a03013ece07)), closes [#101](https://github.com/derekwinters/roadtrip-backend/issues/101)
* **games:** add Dots and Boxes as a seventh game type ([#164](https://github.com/derekwinters/roadtrip-backend/issues/164)) ([a7a1ed3](https://github.com/derekwinters/roadtrip-backend/commit/a7a1ed366c13aed067fe4602a4643511a57f5198)), closes [#116](https://github.com/derekwinters/roadtrip-backend/issues/116)
* **games:** add Four in a Row as a sixth game type ([#162](https://github.com/derekwinters/roadtrip-backend/issues/162)) ([e4ef18f](https://github.com/derekwinters/roadtrip-backend/commit/e4ef18f044e34cea08115cfebe88caccb8eee40e)), closes [#112](https://github.com/derekwinters/roadtrip-backend/issues/112)
* **games:** let parents enable or disable game types family-wide ([#163](https://github.com/derekwinters/roadtrip-backend/issues/163)) ([2be3504](https://github.com/derekwinters/roadtrip-backend/commit/2be35045b9b1c8405620337a56968e487e24e787)), closes [#115](https://github.com/derekwinters/roadtrip-backend/issues/115)
* **geocode:** keep geocode failure reasons in a durable operational log ([#155](https://github.com/derekwinters/roadtrip-backend/issues/155)) ([d2094c7](https://github.com/derekwinters/roadtrip-backend/commit/d2094c71203ad46c6865e93c46550a9aaa442a14)), closes [#89](https://github.com/derekwinters/roadtrip-backend/issues/89)
* **location:** let parents label any stop with a user-supplied name ([#160](https://github.com/derekwinters/roadtrip-backend/issues/160)) ([63b0ea6](https://github.com/derekwinters/roadtrip-backend/commit/63b0ea66f9e3086b22069f84f32bd77a5b78f544)), closes [#104](https://github.com/derekwinters/roadtrip-backend/issues/104)
* **location:** track drive-through cities with configurable population and stop/through toggles ([#161](https://github.com/derekwinters/roadtrip-backend/issues/161)) ([307871c](https://github.com/derekwinters/roadtrip-backend/commit/307871ce348ad93edb36d2508690ae384a55efe6)), closes [#100](https://github.com/derekwinters/roadtrip-backend/issues/100)


### Bug Fixes

* **deps:** migrate to zod 4 ([#156](https://github.com/derekwinters/roadtrip-backend/issues/156)) ([e44c15d](https://github.com/derekwinters/roadtrip-backend/commit/e44c15d320f0c3fdaea56e6d7b02c8359e511b74)), closes [#150](https://github.com/derekwinters/roadtrip-backend/issues/150)

## [1.1.0](https://github.com/derekwinters/roadtrip-backend/compare/v1.0.0...v1.1.0) (2026-07-20)


### Features

* **location:** manual end-leg + re-evaluate arrival while stopped ([#88](https://github.com/derekwinters/roadtrip-backend/issues/88)) ([c7edd1a](https://github.com/derekwinters/roadtrip-backend/commit/c7edd1a65f8a8c4d92aa71f534d83f2526036a61))

## 1.0.0 (2026-07-19)


### ⚠ BREAKING CHANGES

* TripSummary no longer includes wins_by_profile or journal_posts_by_profile.

### Features

* event-sourced Family Road Trip backend (specs, API, location engine, games, CI) ([62ce257](https://github.com/derekwinters/roadtrip-backend/commit/62ce257c02b75fb3c69ca35b63663c071b37d83c))
* event-sourced games platform with five engines ([0cae2a6](https://github.com/derekwinters/roadtrip-backend/commit/0cae2a6512ed06dddf0adaa552f53f3da423bac7))
* first-run bootstrap, address search, itinerary planning, license plate bingo ([#71](https://github.com/derekwinters/roadtrip-backend/issues/71)) ([885b08e](https://github.com/derekwinters/roadtrip-backend/commit/885b08e738e77a1eb9d018fe976de0f0fb79dc94))
* **games:** checkers accepts algebraic moves matching the client ([#75](https://github.com/derekwinters/roadtrip-backend/issues/75)) ([5d9dcca](https://github.com/derekwinters/roadtrip-backend/commit/5d9dcca69267fb52887868b62dafc056ba80a390))
* **games:** expose masked hangman_display in the games list (app [#81](https://github.com/derekwinters/roadtrip-backend/issues/81)) ([454b580](https://github.com/derekwinters/roadtrip-backend/commit/454b580fe911e470b44a44e2dab5f40b673e3069))
* **games:** hangman resign asymmetry — only the setter can end ([#77](https://github.com/derekwinters/roadtrip-backend/issues/77)) ([bf737d9](https://github.com/derekwinters/roadtrip-backend/commit/bf737d9c3dd466d6f99c4f7fffa8668f403ec2af))
* **geocode:** distinguish upstream-unreachable from upstream-error ([#78](https://github.com/derekwinters/roadtrip-backend/issues/78)) ([9759caf](https://github.com/derekwinters/roadtrip-backend/commit/9759caf83823758c4193a560718d910a3a84933f))
* GHCR image publishing and pull-only docker-compose ([e9001e1](https://github.com/derekwinters/roadtrip-backend/commit/e9001e12dbe180a3e6df855a9706c9119865a0ca)), closes [#56](https://github.com/derekwinters/roadtrip-backend/issues/56)
* journal read model and per-profile notification feed ([d8f006c](https://github.com/derekwinters/roadtrip-backend/commit/d8f006cd81f3f246d72317efccf908416c94765d))
* location pipeline, GPS trip simulator, and demo seed ([fe57944](https://github.com/derekwinters/roadtrip-backend/commit/fe57944ed93105e0aaeb6a3af7216152607b31cc))
* multiple road trips + GHCR pull-only deployment ([1bd531c](https://github.com/derekwinters/roadtrip-backend/commit/1bd531cb4a2a52d314a9a1543b9bf3968438d66e))
* multiple road trips with per-trip history ([6fa707b](https://github.com/derekwinters/roadtrip-backend/commit/6fa707b9aef2ece596609e82bb1b0391e3e01d84))
* open profile creation by default, with a parent off-switch ([#74](https://github.com/derekwinters/roadtrip-backend/issues/74)) ([8373ac4](https://github.com/derekwinters/roadtrip-backend/commit/8373ac469886617d80e6af11b724f6132fcecab7))
* scaffold event-sourced API server with CI and release automation ([32c00a8](https://github.com/derekwinters/roadtrip-backend/commit/32c00a87a05d5f72a9c7e6c400399570fcab8695))
* stop game-result notifications; drop per-person trip stats ([#76](https://github.com/derekwinters/roadtrip-backend/issues/76), [#79](https://github.com/derekwinters/roadtrip-backend/issues/79)) ([7b06e9b](https://github.com/derekwinters/roadtrip-backend/commit/7b06e9b2836aec76d755d21039eb0ca00a0e3933))


### Bug Fixes

* explain the closed first-run bootstrap in the 401 message ([#73](https://github.com/derekwinters/roadtrip-backend/issues/73)) ([0e4f4f2](https://github.com/derekwinters/roadtrip-backend/commit/0e4f4f255b7c764eba9331c208393c3fe045977b))
