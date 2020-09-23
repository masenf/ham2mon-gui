try {
  require('./config');
} catch (e) {
  console.log("Error: You must have a configuration file in server path! [config.json]");
  process.exit();
}
const config = require('./config');
const fs = require('fs');
const util = require('util');
const readdir = util.promisify(fs.readdir);
const cors = require('cors');
const path = require('path');
const sanitize = require("sanitize-filename");
const getSize = require('get-folder-size');
const disk = require('diskusage');
const chokidar = require('chokidar');
const sqlite3 = require('sqlite3')
const dayjs = require('dayjs');
const wavFileInfo = require('wav-file-info');

const express = require('express');
const app = express();
const default_port = 8080;
const NodeCache = require("node-cache");
const fileCache = new NodeCache({stdTTL: 10});

app.use(cors());
app.use(express.urlencoded({extended: true}));
app.use(express.json());

// handle values from config file

let wavDir;
wavDir = config.wavDir;
if (!wavDir) {
  console.log("Error: You must have a wavDir set in config file!");
  process.exit();
}

let archiveDir;
archiveDir = config.archiveDir;
if (!archiveDir) {
  console.log("Error: You must have a archiveDir set in config file!");
  process.exit();
}

let port = config.port;
if (!port) {
  port = default_port;
}

let db_path = config.db_path;
if (!db_path) {
  db_path = "./db.v1.sqlite";
}

let minCallLength = config.minCallLength;
if (!minCallLength) {
  minCallLength = 3.5;
}

const DB = new sqlite3.Database(db_path, function(err) {
  if (err) {
    console.log(err);
    process.exit();
  }
  console.log(`Connected to ${db_path} database.`)
});
DB.exec(
  `CREATE TABLE IF NOT EXISTS calls (
    id integer NOT NULL PRIMARY KEY,
    frequency text NOT NULL,
    time integer NOT NULL,
    duration numeric NOT NULL,
    relative_path text NOT NULL
  );`, function(err) {
  if (err) {
    console.log(err);
    process.exit();
  }
});

// archive valid WAV files from ham2mon
function archive_call(path) {
  const pathComponents = path.split('/');
  const fileName = pathComponents[pathComponents.length-1];
  const [freq, time] = fileName.slice(0, -4).split('_');
  // determine if we're dealing with a valid WAV
  wavFileInfo.infoByFilename(path, function(err, info) {
    if (err) {
      console.log(err);
      return;
    }
    let duration = info.stats.size / info.header.byte_rate;
    if (duration < minCallLength) return;
    // move it to the appropriate location
    const archive_subdir = `${dayjs(time * 1000).format('YYYY/MM/DD')}`;
    const relative_path = `${archive_subdir}/${fileName}`;
    const target_path = `${archiveDir}/${relative_path}`;
    fs.mkdir(`${archiveDir}/${archive_subdir}`, { recursive: true }, (err) => {
      if (err) {
        console.log(err);
        return;
      }
      fs.rename(path, target_path, err => {
        if (err) {
          console.log(err);
          return;
        }
        console.log(`Moved ${path} to ${target_path}`);
        DB.run(
          `INSERT INTO calls (frequency, time, duration, relative_path)
           VALUES (?, ?, ?, ?);`,
          [freq, time, duration, relative_path],
          function(err) {
            if (err) {
              console.log(err);
              return;
            }
        });
      });
    });
  });
}

function rescan(dir) {
  const files = fs.readdir(dir, (err, files) => {
    files.map(file => {
      archive_call(`${wavDir}/${file}`);
    });
  });
}

rescan(wavDir)

// start watching the wavDir
const watcher = chokidar.watch(wavDir, {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true,
  awaitWriteFinish: {
    stabilityThreshold: 1000,
    pollInterval: 200
  },
});
watcher.on('add', path => {
  console.log(`File ${path} has been added`);
  archive_call(path);
});

function getSizePromise(dir) {
  return new Promise((resolve, reject) => {
    getSize(dir, (err, size) => {
      if (err) {
        reject(err);
      } else {
        resolve(size);
      }
    });
  })
}

async function getAllFiles(forceUpdate) {
  let fileData = fileCache.get("allFiles");

  if (fileData === undefined || forceUpdate) {
    fileData = await getFileData();
    fileCache.set('allFiles', fileData);
  }
  return fileData;
}

setInterval(() => { rescan(wavDir); }, 20000);

app.post('/data', async (req, res) => {
  let fileData = await getAllFiles();

  let dirSize = fileCache.get('dirSize');
  let availableSpace = fileCache.get('availableSpace');

  if (dirSize === undefined) {
    dirSize = await getSizePromise(wavDir);
    const result = await disk.check(wavDir);
    availableSpace = result.available;

    fileCache.set('dirSize', dirSize, 60 * 60);
    fileCache.set('availableSpace', availableSpace, 60 * 60);
  }

  const {fromTime} = req.body;

  if (fromTime) {
    fileData = fileData.filter(file => file.time >= fromTime);
  }

  res.json({
    files: fileData,
    dirSize,
    freeSpace: availableSpace
  });
});

function deleteFiles(files) {
  for (let file of files) {
    try {
      fs.unlinkSync(wavDir + "/" + sanitize(file));
      console.log("Deleted " + file);
    } catch (e) {
      console.log("Error deleting file " + file, e);
    }
  }
}

app.post('/deleteBefore', async (req, res) => {
  const {deleteBeforeTime} = req.body;

  const allFiles = await getFileData();
  const filesToDelete = allFiles
    .filter(file => file.time < deleteBeforeTime)
    .map(file => file.file);

  deleteFiles(filesToDelete);

  fileCache.del('dirSize');
  fileCache.del('availableSpace');

  res.json({});
});

app.post('/delete', async (req, res) => {
  const {files} = req.body;

  deleteFiles(files);

  res.json({});
});

app.use('/static', express.static(wavDir));
app.use('/', express.static(path.join(__dirname, '../build')));

app.listen(port, () => console.log(`Example app listening at http://localhost:${port}`));

async function getFileData() {
  const files = await readdir(wavDir);

  const fileData = files.map(file => {
    // Strip ext
    const fileName = file.slice(0, -4);
    const [freq, time] = fileName.split('_');
    const stats = fs.statSync(wavDir + "/" + file);

    return {
      freq,
      time,
      file,
      size: stats.size
    };
  });

  console.log(fileData.length);

  return fileData.filter(
    file => {
      return file.size > 60000
    }
  );
}

