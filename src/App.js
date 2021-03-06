import React, {useEffect, useRef, useState, useCallback} from 'react';
import axios from 'axios';
import Call from './Call';
import {useLocalStorage} from './hooks/useLocalStorage';
import './App.css';
import produce from 'immer';
import DateTimeRangePicker from '@wojtekmaj/react-datetimerange-picker';
import {BooleanOption} from './BooleanOption';
import {NowPlaying} from './NowPlaying';
import {getFreqStats, getParameterByName, getParameterByNameSplit, usePrevious} from './Utils';
import {useHotkeys} from 'react-hotkeys-hook';
import Select from 'react-select';
import useDimensions from 'react-use-dimensions';
import {primary, primary2, primary4, secondary25} from './color';
import ReactList from 'react-list';
import {Settings} from './Settings';
import {useWindowSize} from './hooks/useWindowSize';
import dayjs from 'dayjs';

function App() {
  const windowSize = useWindowSize();
  const [optionsBlockRef, optionsBlockDimensions] = useDimensions();

  const styles = {
    optionsBlock: {
      position: 'fixed',
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'space-around',
      top: 0,
      padding: 6,
      backgroundColor: '#FFF',
      width: '100%',
      borderBottom: '1px solid #eee',
      zIndex: 1000,
      boxShadow: '1px 1px 2px #adadad',
      boxSizing: 'border-box',
    },
    leftOptionsBlock: {
      marginRight: windowSize.width >= 600 ? 8 : 0,
      width: windowSize.width >= 600 ? '40%' : '100%',
    },
    rightOptionsBlock: {
      boxSizing: 'border-box',
      flexGrow: 1,
      backgroundColor: secondary25,
      padding: 10,
      borderRadius: 4,
      boxShadow: '1px 1px 2px #999',
      width: 1,
    },
    buttons: {
      display: 'flex',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
    },
    records: {
      paddingTop: optionsBlockDimensions.height
        ? optionsBlockDimensions.height + 2
        : 0,
    },
    audio: {
      width: '100%',
      userSelect: 'none',
      outline: 0,
      boxShadow: '1px 1px 2px #999',
      borderRadius: 30,
    },
    select: {
      outline: 0,
    },
    loadError: {
      backgroundColor: primary2,
      color: primary4,
      padding: 10,
      margin: 10,
      borderRadius: 4,
    },
    loading: {
      color: primary4,
      padding: 10,
      margin: 10,
      textAlign: 'center',
      fontWeight: 400,
    },
  };

  const [calls, setCalls] = useState([]);
  const [selected, setSelected] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [dirSize, setDirSize] = useState(null);
  const [freeSpace, setFreeSpace] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [freqStats, setFreqStats] = useState([]);
  const [loading, setLoading] = useState(true);
  // array of [newest_call_time, last_checked_time]
  const [callWaiting, setCallWaiting] = useState(false);

  const [mobileSettingsOpen, setMobileSettingsOpen] = useLocalStorage(
    'mobileSettingsOpen',
    false,
  );
  const [listenedArr, setListenedArr] = useLocalStorage('listenedArr', []);
  const [likedArr, setLikedArr] = useLocalStorage('likedArr', []);
  const [hiddenArr, setHiddenArr] = useLocalStorage('hiddenArr', []);
  const [autoplay, setAutoplay] = useLocalStorage('autoplay', true);
  const [autoloadDelay, setAutoloadDelay] = useLocalStorage('setAutoloadDelay', 0);
  const [freqData, setFreqData] = useLocalStorage('freqData', []);
  const [showRead, setShowRead] = useLocalStorage('showRead', true);
  const [selectedFreqs, setSelectedFreqs] = useLocalStorage('selectedFreqs', ["0"]);
  const [showSince, setShowSince] = useLocalStorage(
    'setShowSince',
    60 * 60 * 24,
  );

  const audioRef = useRef(null);
  const filteredCallRefs = useRef([]);

  const [buttonsRef, buttonsDimensions] = useDimensions();

  const newestCallTime = calls.reduce((acc, cur) => Math.max(acc, cur.time), 0);
  const selectedCall = calls.find((call) => call.file === selected);
  const allFreqs = calls.map((call) => call.freq);

  const uniqueFreqs = [...new Set(allFreqs)];

  const unlistenedCalls = calls.filter(
    (call) => !listenedArr.includes(call.file),
  );

  let filteredFreqs = uniqueFreqs.filter((freq) => !hiddenArr.includes(freq));

  if (showHidden) {
    filteredFreqs = uniqueFreqs.filter((freq) => hiddenArr.includes(freq));
  }

  const end_param = getParameterByName("end");
  const start_param = getParameterByName("start");
  const default_end = dayjs();
  const default_start = default_end.subtract(showSince, "seconds");
  const end = end_param ? dayjs(end_param) : default_end;
  const start = start_param ? dayjs(start_param) : default_start;
  const [callDateRange, setCallDateRange] = useState([start.toDate(), end.toDate()]);
  const prevCallDateRange = usePrevious(callDateRange);
  const [rangeWasSet, setRangeWasSet] = useState([start_param, end_param]);

  const fetchDataRange = (async (afterTime, beforeTime) => {
    // return {files, dirSize, freeSpace}
    if (!afterTime || !beforeTime) {
      throw new Error("afterTime and beforeTime must be specified");
    }
    try {
      console.log(`requesting calls between ${dayjs(afterTime * 1000).format('YYYY-MM-DD HH:mm:ss')} and ${dayjs(beforeTime* 1000).format('YYYY-MM-DD HH:mm:ss')}`);
      const result = await axios.post('/data', {
        afterTime: afterTime,
        beforeTime: beforeTime,
      });
      return result.data;
    } catch (e) {
      setLoadError(true);
      throw e;
    }
  });

  const updateRange = useCallback(async (prevRange, curRange) => {
    let fetchRanges = [];

    // if prevRange is undefined
    //   or curRange[0] > prevRange[1]: non-overlap
    //   or curRange[1] < prevRange[0]: non-overlap
    //   ---> clear calls and grab the full curRange
    // if curRange[0] < prevRange[0]: request older - fetch and update
    // if curRange[1] > prevRange[1]: request newer - fetch and update
    if (prevRange === undefined ||
        prevRange[0] > curRange[1] ||
        prevRange[1] < curRange[0]) {
      // non-overlapping dataset or initial load
      setCalls([]);  // clear existing calls
      // fetch all data
      fetchRanges.push({
        afterTime: Math.floor(curRange[0].valueOf() / 1000),
        beforeTime: Math.floor(curRange[1].valueOf() / 1000),
      });
    } else {
      if (curRange[0] < prevRange[0]) {
        // fetch earlier data
        fetchRanges.push({
          afterTime: Math.floor(curRange[0].valueOf() / 1000),
          beforeTime: Math.floor(prevRange[0].valueOf() / 1000),
        });
      }
      if (prevRange[1] < curRange[1]) {
        // fetch newer data
        fetchRanges.push({
          afterTime: newestCallTime ? newestCallTime : Math.floor(prevRange[1].valueOf() / 1000),
          beforeTime: Math.floor(curRange[1].valueOf() / 1000),
        });
      }
    }
    setLoading(true);
    Promise.all(fetchRanges.map(async (range) => {
      fetchDataRange(range.afterTime, range.beforeTime).then(({files, dirSize, freeSpace}) => {
        setDirSize(dirSize);
        setFreeSpace(freeSpace);
        if (files.length > 0) {
          setCalls(c => c.concat(files).sort((tc1, tc2) => tc1.time - tc2.time));
        }
      }).catch((e) => {
        console.log(`Cannot update data: ${e}`);
      });
    })).then(() => setLoading(false));
  }, [fetchDataRange, newestCallTime]);

  // poll for new calls by setting callDateRange with a timeout
  useEffect(() => {
    if (autoloadDelay <= 0) return;
    const timer = setTimeout(() => {
      if (rangeWasSet[1]) {
        return;  // end date was set, so don't autoload
      }
      // request all calls since the last call
      setCallDateRange(([start, end]) => [start, new Date()]);
    }, autoloadDelay * 1000);
    return () => clearTimeout(timer);
  }, [autoloadDelay, callDateRange, rangeWasSet]);

  // call updateRange when callDateRange changes
  useEffect(() => {
    updateRange(prevCallDateRange, callDateRange);
  }, [prevCallDateRange, callDateRange, updateRange]);

  useEffect(() => {
    const orderedStats = getFreqStats(calls);

    setFreqStats(orderedStats);
  }, [calls, showSince]);

  const frequencyListItems = [...filteredFreqs].sort().map((freq) => {
    const freqItem = freqData.find((freqItem) => freqItem.freq === freq);
    const unlistenedCount = unlistenedCalls.filter((call) => call.freq === freq)
      .length;

    return {
      freq,
      name: freqItem ? freqItem.name : '',
      unlistenedCount,
    };
  });

  let filteredCalls = calls.filter((call) => !hiddenArr.includes(call.freq));

  if (showHidden) {
    filteredCalls = calls.filter((call) => hiddenArr.includes(call.freq));
  }

  filteredCalls = filteredCalls.filter((call) => {
    const callTime = call.time * 1000;
    return (callDateRange[0].valueOf() <= callTime && callTime <= callDateRange[1].valueOf());
  });

  if (selectedFreqs) {
    filteredCalls = filteredCalls.filter((call) => selectedFreqs.includes(call.freq));
  }

  if (!showRead) {
    filteredCalls = filteredCalls.filter(
      (call) => !listenedArr.includes(call.file),
    );
  }

  filteredCallRefs.current = new Array(filteredCalls.length);

  const selectedCallIndex = filteredCalls.findIndex(
    (call) => call.file === selected,
  );

  const scrollIntoView = (offset = 1, options = {block: 'nearest'}) => {
    try {
      filteredCallRefs.current[selectedCallIndex + offset].scrollIntoView(options);
    } catch (ignore) {
    }
  };

  const playNext = (skipAmount = 1) => {
    const nextCall = filteredCalls[selectedCallIndex + skipAmount];

    setListenedArr([...listenedArr, selected]);
    if (nextCall) {
      setSelected(nextCall.file);
    } else {
      // nothing to play yet, but try again when new calls come in
      setCallWaiting(true);
    }
  };

  // automatically play new calls as they come in
  useEffect(() => {
    if (!filteredCalls.length || (selectedCallIndex === filteredCalls.length-1) || !callWaiting || !autoplay) return;
    setCallWaiting(false);
    // scroll the newly added call into view
    scrollIntoView();
    playNext();
  }, [calls, callWaiting, selected]);

  function pause(event) {
    event.preventDefault();

    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  }

  useHotkeys('k,down', () => playNext(), {}, [
    selected,
    listenedArr,
    filteredCalls,
    filteredCallRefs,
  ]);
  useHotkeys('j,up', () => playNext(-1), {}, [
    selected,
    listenedArr,
    filteredCalls,
  ]);
  useHotkeys('space', (event) => pause(event), {}, [audioRef, playing]);
  useHotkeys('shift+k,shift+down', () =>
    window.scrollTo(0, document.body.scrollHeight),
  );

  useHotkeys('shift+j,shift+up', () => window.scrollTo(0, 0));
  useHotkeys('s', () => (audioRef.current.currentTime += 5));
  useHotkeys('a', () => (audioRef.current.currentTime -= 5));

  const selectOptions = frequencyListItems.map((freqItem) => ({
    value: freqItem.freq,
    label: (
      <div
        style={{
          fontWeight: freqItem.unlistenedCount ? '500' : 'auto',
        }}>
        {`${freqItem.freq} ${freqItem.name ? freqItem.name : ''} (${
          freqItem.unlistenedCount
        })`}
      </div>
    ),
  }));

  const selectedFreqItems = selectedFreqs ? selectOptions.filter((opt) => selectedFreqs.includes(opt.value)) : [];

  // parse `?freq=` param from url (on initial render only)
  useEffect(() => {
    const queryParamFreqs = getParameterByNameSplit("freq", ",");
    if (queryParamFreqs.length > 0) {
      setSelectedFreqs(queryParamFreqs);
    }
  }, []);

  // update `?freq=` param in url for easier sharing
  // update `?start=&end=` param in url for easier sharing
  useEffect(() => {
    if (window.history.replaceState) {
        const [start, end] = callDateRange.map((d) => dayjs(d).format());
        const [startWasSet, endWasSet] = rangeWasSet;
        const range = (startWasSet ? `&start=${start}` : "") + (endWasSet ? `&end=${end}`: "");
        var newurl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?freq=' + selectedFreqs.join(",") + range;
        window.history.replaceState({path:newurl},'',newurl);
    }
  }, [selectedFreqs, callDateRange, rangeWasSet])

  const customStyles = {
    control: (base, state) => ({
      ...base,
      boxShadow: 'none',
      borderColor: '#EEE !important',
      height: 44,
      marginBottom: windowSize.width >= 600 ? 0 : 4,
    }),
  };

  const handleDeleteBefore = async (beforeTime) => {
    await axios.post(`/deleteBefore`, {
      deleteBeforeTime: Math.floor(Date.now() / 1000) - beforeTime,
    });

    window.location.reload();
  };

  return (
    <div>
      <Settings
        visible={showSettings}
        dirSize={dirSize}
        freeSpace={freeSpace}
        handleClose={() => setShowSettings(false)}
        freqStats={freqStats}
        showSince={showSince}
        setShowSince={setShowSince}
        setSelectedFreqs={setSelectedFreqs}
        handleDeleteBefore={handleDeleteBefore}
        freqData={freqData}
        autoloadDelay={autoloadDelay}
        setAutoloadDelay={setAutoloadDelay}
      />
      <div ref={optionsBlockRef} style={styles.optionsBlock}>
        {windowSize.width >= 600 || mobileSettingsOpen ? (
          <div style={styles.leftOptionsBlock}>
            <div ref={buttonsRef} style={styles.buttons}>
              <BooleanOption
                title={'Autoplay'}
                containerWidth={buttonsDimensions.width}
                value={autoplay}
                onClick={() => {
                  setAutoplay(!autoplay);
                }}
              />
              <BooleanOption
                title={'Settings'}
                containerWidth={buttonsDimensions.width}
                onClick={() => {
                  setShowSettings(true);
                }}
              />
              <BooleanOption
                title={'Hide Listened'}
                containerWidth={buttonsDimensions.width}
                value={!showRead}
                onClick={() => {
                  setShowRead(!showRead);
                }}
              />
              <BooleanOption
                title={'Show Hidden'}
                containerWidth={buttonsDimensions.width}
                value={showHidden}
                onClick={() => {
                  setShowHidden(!showHidden);
                }}
              />
              <BooleanOption
                title={'Scroll to Top'}
                containerWidth={buttonsDimensions.width}
                onClick={() => {
                  window.scrollTo(0, 0);
                }}
              />
              <BooleanOption
                title={'Scroll to Bottom'}
                containerWidth={buttonsDimensions.width}
                onClick={() => {
                  window.scrollTo(0, document.body.scrollHeight);
                }}
              />
              <BooleanOption
                title={'Delete Listened'}
                containerWidth={buttonsDimensions.width}
                warning={true}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Are you sure you want to delete all listened audio${
                        selectedFreqs ? ' on this freq?' : '?'
                      }`,
                    )
                  ) {
                    return false;
                  }

                  let filesToDelete;

                  if (selectedFreqs) {
                    filesToDelete = calls
                      .filter(
                        (call) =>
                          selectedFreqs.includes(call.freq) &&
                          listenedArr.includes(call.file),
                      )
                      .map((call) => call.file);
                  } else {
                    filesToDelete = calls
                      .filter((call) => listenedArr.includes(call.file))
                      .map((call) => call.file);
                  }

                  await axios.post(`/delete`, {
                    files: filesToDelete,
                  });

                  setSelectedFreqs([]);
                  updateRange(undefined, callDateRange);
                }}
              />
              <BooleanOption
                title={'Mark Listened'}
                containerWidth={buttonsDimensions.width}
                warning={true}
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Are you sure you want to mark ${
                        selectedFreqs ? 'this frequency' : 'all calls'
                      } as read?`,
                    )
                  ) {
                    return false;
                  }

                  let itemsToMark;

                  if (selectedFreqs) {
                    itemsToMark = unlistenedCalls.filter(
                      (call) => selectedFreqs.includes(call.freq),
                    );
                  } else {
                    itemsToMark = calls;
                  }
                  const tmpListenedArr = await produce(
                    listenedArr,
                    async (draft) => {
                      itemsToMark.forEach((call) => {
                        draft.push(call.file);
                      });
                    },
                  );

                  setListenedArr(tmpListenedArr);
                }}
              />
            </div>
            <div>
              <DateTimeRangePicker
                onChange={(v) => {
                  setRangeWasSet([true, true]);
                  if (v) {
                    setCallDateRange(v);
                  } else {
                    setCallDateRange([default_start.toDate(), default_end.toDate()]);
                    setRangeWasSet([false, false]);
                  }
                }}
                value={callDateRange}
              />
            </div>
            <div>
              <Select
                style={styles.select}
                value={selectedFreqItems}
                placeholder={'Select a frequency'}
                isMulti={true}
                options={selectOptions}
                styles={customStyles}
                theme={(theme) => ({
                  ...theme,
                  borderRadius: 4,
                  colors: {
                    ...theme.colors,
                    primary25: primary2,
                    primary: primary,
                  },
                })}
                onChange={(res) => {
                  if (res) {
                    setSelectedFreqs(res.map((r) => r.value));
                  } else {
                    setSelectedFreqs([]);
                  }

                  setTimeout(() => {
                    window.scrollTo(0, document.body.scrollHeight);
                  }, 200);
                }}
              />
            </div>
          </div>
        ) : null}
        {windowSize.width < 600 ? (
          <div style={{width: '100%'}}>
            <BooleanOption
              fullWidth={true}
              title={!mobileSettingsOpen ? 'Open Panel' : 'Close Panel'}
              onClick={() => setMobileSettingsOpen(!mobileSettingsOpen)}
            />
          </div>
        ) : null}
        <div style={styles.rightOptionsBlock}>
          <NowPlaying call={selectedCall} freqData={freqData} scrollIntoView={scrollIntoView} />
          <audio
            ref={audioRef}
            style={styles.audio}
            onPlay={() => {
              setPlaying(true);
            }}
            onPause={() => {
              setPlaying(false);
            }}
            onEnded={() => {
              setPlaying(false);

              if (!autoplay) {
                return;
              }

              playNext();
            }}
            // set autoPlay for taps and keyboard input
            autoPlay={true}
            preload={'none'}
            src={selected ? `/static/${selected}` : null}
            controls
          />
        </div>
      </div>

      <div style={styles.records}>
        {loadError ? (
          <div style={styles.loadError}>
            There was an issue connecting to the server. Please ensure the
            settings are correct.
          </div>
        ) : null}

        {!loading && !filteredCalls.length && !loadError ? (
          <div style={styles.loadError}>
            No calls to display. Try changing frequency.
          </div>
        ) : null}
        {loading && filteredCalls.length === 0 ? (
          <div style={styles.loading}>Loading calls...</div>
        ) : (
          <ReactList
            itemRenderer={(index, key) => {
              const call = filteredCalls[index];

              return (
                <div
                  key={index}
                  ref={(el) => (filteredCallRefs.current[index] = el)}>
                  <Call
                    data={call}
                    autoplay={autoplay}
                    selected={selected === call.file}
                    listened={listenedArr.includes(call.file)}
                    hidden={hiddenArr.includes(call.freq)}
                    liked={likedArr.includes(call.freq)}
                    freqData={freqData}
                    setFreqData={setFreqData}
                    onClick={() => {
                      setListenedArr([...listenedArr, selected]);
                      setSelected(call.file);
                    }}
                    onLike={() => {
                      setLikedArr([...likedArr, call.freq]);
                    }}
                    onHide={() => {
                      setHiddenArr([...hiddenArr, call.freq]);
                    }}
                    onUnhide={() => {
                      setHiddenArr(
                        hiddenArr.filter((freq) => freq !== call.freq),
                      );
                    }}
                    onUnlike={() => {
                      setLikedArr(
                        likedArr.filter((freq) => freq !== call.freq),
                      );
                    }}
                    handleMarkRead={async (freq) => {
                      if (
                        !window.confirm(
                          'Are you sure you want to mark all as read?',
                        )
                      ) {
                        return false;
                      }

                      const itemsToMark = unlistenedCalls.filter(
                        (call) => call.freq === freq,
                      );
                      const tmpListenedArr = await produce(
                        listenedArr,
                        async (draft) => {
                          itemsToMark.forEach((call) => {
                            draft.push(call.file);
                          });
                        },
                      );

                      setListenedArr(tmpListenedArr);
                    }}
                  />
                </div>
              );
            }}
            minSize={50}
            length={filteredCalls.length}
            type="uniform"
          />
        )}
      </div>
    </div>
  );
}

export default App;
