"use client";

// THE CITY-MANAGER NAV LIST — three items, one array, rendered by the SAME rail, app bar and
// screen sheet the rest of the app uses.
//
// This replaced a bespoke horizontal pill row (the deleted CityNav). The pill row was not just a
// different shape — it made the tier look like a different product bolted onto the same login.
// The tier is not a different product; it is the same application with fewer doors, and the
// chrome is the thing that says so.
//
// ICONS COME FROM MATCH_OPS_SECTIONS BY KEY, never copied. Gameday Ops, Reviews and Manager Pay
// are the same three screens an admin has, so they carry the same marks; copying the path data
// would let the two rails drift apart one edit at a time.
//
// ORDER IS DELIBERATE. Manager Pay is first: it is the primary page and the only one carrying a
// write (the manager assignment). Gameday Ops is read-only here and last.
//
// NO GROUP HEADINGS. `group: ""` — three items in one group is not structure, and a heading over
// all of them is the same chrome-pretending-to-be-structure the missing Daily Ops / Back Office
// switch would be.

import { iconFor, type RailItem } from "../match-ops/sections";

export const CITY_SECTIONS: RailItem[] = [
  {
    key: "city-manager-pay",
    group: "",
    label: "Manager Pay",
    href: "/city/manager-pay",
    desc: "What each manager is owed this week, and who is assigned",
    icon: iconFor("manager-pay"),
  },
  {
    key: "city-reviews",
    group: "",
    label: "Reviews",
    href: "/city/reviews",
    desc: "Per-match ratings and manager standings for your city",
    icon: iconFor("reviews"),
  },
  {
    key: "city-gameday",
    group: "",
    label: "Gameday Ops",
    href: "/city/gameday",
    desc: "Today's matches, soonest first — what's about to go wrong",
    icon: iconFor("gameday"),
  },
];
