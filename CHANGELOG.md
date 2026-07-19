# Changelog

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
