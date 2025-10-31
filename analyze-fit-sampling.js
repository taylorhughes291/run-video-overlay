#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const FitParser =
  require("fit-file-parser").default || require("fit-file-parser");

const fitFile = process.argv[2] || "20843858458_ACTIVITY.fit";

if (!fs.existsSync(fitFile)) {
  console.error(`File not found: ${fitFile}`);
  process.exit(1);
}

const content = fs.readFileSync(fitFile);
const parser = new FitParser({
  force: true,
  speedUnit: "m/s",
  lengthUnit: "m",
  temperatureUnit: "celsius",
  elapsedRecordField: true,
  mode: "both", // Use 'both' mode to get records
});

parser.parse(content, (err, data) => {
  if (err) {
    console.error("Failed to parse:", err);
    process.exit(1);
  }

  // Records are at the top level in 'both' mode
  const records = data.records || [];
  if (records.length === 0) {
    console.log("No records found in FIT file");
    process.exit(1);
  }

  console.log(`\n=== FIT File Sampling Rate Analysis ===\n`);
  console.log(`Total records: ${records.length}`);

  const first = records[0];
  const last = records[records.length - 1];

  if (first.timestamp && last.timestamp) {
    const start = new Date(first.timestamp).getTime();
    const end = new Date(last.timestamp).getTime();
    const duration = (end - start) / 1000;
    const avgInterval = duration / (records.length - 1);
    const samplingRate = 1 / avgInterval;

    console.log(
      `Duration: ${duration.toFixed(2)} seconds (${(duration / 60).toFixed(
        2
      )} minutes)`
    );
    console.log(`Average interval: ${(avgInterval * 1000).toFixed(2)} ms`);
    console.log(`Sampling rate: ${samplingRate.toFixed(3)} samples per second`);
    console.log(`\nFirst record: ${first.timestamp}`);
    console.log(`Last record: ${last.timestamp}`);

    // Analyze intervals
    if (records.length > 1) {
      const intervals = [];
      for (let i = 1; i < Math.min(records.length, 1000); i++) {
        if (records[i - 1].timestamp && records[i].timestamp) {
          const t1 = new Date(records[i - 1].timestamp).getTime();
          const t2 = new Date(records[i].timestamp).getTime();
          intervals.push((t2 - t1) / 1000);
        }
      }

      if (intervals.length > 0) {
        const minInterval = Math.min(...intervals);
        const maxInterval = Math.max(...intervals);
        const avgIntervalCalc =
          intervals.reduce((a, b) => a + b, 0) / intervals.length;

        console.log(
          `\n--- Interval Analysis (first ${intervals.length} intervals) ---`
        );
        console.log(`Min interval: ${(minInterval * 1000).toFixed(2)} ms`);
        console.log(`Max interval: ${(maxInterval * 1000).toFixed(2)} ms`);
        console.log(
          `Average interval: ${(avgIntervalCalc * 1000).toFixed(2)} ms`
        );

        // Count intervals
        const intervalCounts = {};
        intervals.forEach((iv) => {
          const rounded = Math.round(iv * 1000);
          intervalCounts[rounded] = (intervalCounts[rounded] || 0) + 1;
        });

        const mostCommon = Object.entries(intervalCounts).sort(
          (a, b) => b[1] - a[1]
        )[0];
        console.log(
          `Most common interval: ${mostCommon[0]} ms (${mostCommon[1]} occurrences)`
        );
      }
    }

    // Check what data fields are available
    console.log(`\n--- Available Data Fields ---`);
    const sampleRecord = records[Math.floor(records.length / 2)];
    const fields = Object.keys(sampleRecord);
    const relevantFields = [
      "heart_rate",
      "speed",
      "enhanced_speed",
      "cadence",
      "power",
      "distance",
      "altitude",
      "temperature",
    ];

    relevantFields.forEach((field) => {
      if (sampleRecord[field] !== undefined) {
        console.log(`  ✓ ${field}: ${sampleRecord[field]}`);
      }
    });

    // Count how many records have heart rate
    const recordsWithHR = records.filter(
      (r) => r.heart_rate !== undefined
    ).length;
    const recordsWithSpeed = records.filter(
      (r) => r.speed !== undefined || r.enhanced_speed !== undefined
    ).length;

    console.log(`\n--- Data Coverage ---`);
    console.log(
      `Records with heart rate: ${recordsWithHR} (${(
        (recordsWithHR / records.length) *
        100
      ).toFixed(1)}%)`
    );
    console.log(
      `Records with speed/pace: ${recordsWithSpeed} (${(
        (recordsWithSpeed / records.length) *
        100
      ).toFixed(1)}%)`
    );
  } else {
    console.log("No timestamp data found in records");
  }
});
