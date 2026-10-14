/* Roster fixtures shared by the settings sweep and the unit tests: [name, prefs, unavailable game numbers]. */
"use strict";
const FIXTURES = {
  deep11: {note:"11 players, 11 games, bench 2 - good depth everywhere", numGames:11, bench:2, players:[
    ["Liv",["GA","GS"]], ["Poppy",["GS","GA","WA","C","WD"]], ["Mabel",["WA","GA","C","GS","WD"]],
    ["Izzy",["WA","WD"]], ["Layla",["WA","WD"]], ["Ella",["C","GA","WA"]], ["Zara",["C","WA","WD"]],
    ["Maddie",["WD","WA"]], ["Abby",["GD","WD","GK"]], ["Avalon",["GD","GK"]], ["Savanah",["GK","GD"]]]},
  unavail12: {note:"12 players, 8 games, bench 2 - uneven availability, thin GK", numGames:8, bench:2, players:[
    ["Amy",["GS","GA"],[3,7]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"],[2]], ["Fay",["GD","WD"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]],
    ["Jaz",["C","WD","GD"],[5,6]], ["Kim",["GD","GK"]], ["Lou",["GD","WD"]]]},
  thin10: {note:"10 players, 10 games, bench 1 - a sole GK, short preference lists", numGames:10, bench:1, players:[
    ["Ava",["GS","GA"]], ["Bri",["GA","GS"]], ["Cleo",["WA","C"]], ["Dani",["C","WA"]], ["Emme",["WD","C"]],
    ["Flo",["GD","WD"]], ["Gwen",["GK"]], ["Hope",["GS","WA"]], ["Isla",["C","WD","WA"]], ["Joss",["GD","GA"]]]},
  small9: {note:"9 players, 10 games, bench 2 - nobody is ever rostered off", numGames:10, bench:2, players:[
    ["Ana",["GS","GA","WA"]], ["Bex",["GA","GS"]], ["Cora",["WA","C","WD"]], ["Dot",["C","WA"]], ["Edie",["WD","GD","C"]],
    ["Fern",["GD","GK","WD"]], ["Gigi",["GK","GD"]], ["Hana",["GS","GK"]], ["Indi",["C","WD","GA"]]]}
};

module.exports = { FIXTURES };
