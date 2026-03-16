# Mars Location Marker

An interactive 3D globe that shows the direction of Mars from any location on Earth, at any point in time.

**[Live demo](https://anshler.github.io/mars-location-marker/)**

## Features

- Real-time or custom date/time Mars direction visualization
- Search any location on Earth by name or coordinates
- 3D Earth globe with day/night shading, atmosphere, and starfield
- Topocentric Mars position with light-travel time correction

## Usage

Enter a location (city name or lat/lon) and optionally adjust the date and time. A line is drawn from your chosen point on Earth's surface toward Mars, with a marker where it exits the globe.

## Running Locally

```
npm start
```

Serves the app at `http://localhost:8080`. No build step required.

## Accuracy

The orbital calculations are approximate — suitable for visualization, not navigation. If you spot a significant error in the math, please open an issue.

## For Developers

See [CLAUDE.md](CLAUDE.md) for architecture details, module structure, and rendering concepts.