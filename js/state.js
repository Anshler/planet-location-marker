export const state = {
    redMarker:     null,
    locationLabel: null,
    planetObjects: {},
    currentLat: 0,
    currentLon: 0,

    animPlaying:       false,
    animMode:          'realtime',
    animRafHandle:     null,
    animLastTs:        0,
    animStartWall:     0,
    animPausedAt:      0,
    animFromDate:      null,
    animToDate:        null,
    animDuration:      10,
    animRealtimeBase:  null,
    onMarkerSet:       null,
};
