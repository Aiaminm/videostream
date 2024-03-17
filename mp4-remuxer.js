const bs = require('binary-search')
const EventEmitter = require('events')
const mp4 = require('mp4-stream')
const Box = require('mp4-box-encoding')
const RangeSliceStream = require('range-slice-stream')

// if we want to ignore more than this many bytes, request a new stream.
// if we want to ignore fewer, just skip them.
const FIND_MOOV_SEEK_SIZE = 4096

class MP4Remuxer extends EventEmitter {
  constructor (file) {
    super()

    this._tracks = []
    this._file = file
    this._decoder = null
    this._findMoov(0)
  }

  _findMoov (offset) {
    if (this._decoder) {
      this._decoder.destroy()
    }

    let toSkip = 0
    this._decoder = mp4.decode()
    const fileStream = this._file.createReadStream({
      start: offset
    })
    fileStream.pipe(this._decoder)

    const boxHandler = headers => {
      if (headers.type === 'moov') {
        this._decoder.removeListener('box', boxHandler)
        this._decoder.decode(moov => {
          fileStream.destroy()
          try {
            this._processMoov(moov)
          } catch (err) {
            err.message = `Cannot parse mp4 file: ${err.message}`
            this.emit('error', err)
          }
        })
      } else if (headers.length < FIND_MOOV_SEEK_SIZE) {
        toSkip += headers.length
        this._decoder.ignore()
      } else {
        this._decoder.removeListener('box', boxHandler)
        toSkip += headers.length
        fileStream.destroy()
        this._decoder.destroy()
        this._findMoov(offset + toSkip)
      }
    }
    this._decoder.on('box', boxHandler)

  }

  _processMoov (moov) {
    const traks = moov.traks
    this._tracks = []
    this._hasVideo = false
    this._hasAudio = false

    console.log(traks);

    var hevc = Object.assign(Object.create(null), {'hvc1': 1, 'hev1': 1});
    var mp3a = Object.assign(Object.create(null), {'mp4a.6b': 1, 'mp4a.69': 1});
    var vide = Object.assign(Object.create(null), {'avc1': 1, 'av01': 1, 'vp09': 1}, hevc);
    var swap = Object.assign(Object.create(null), {'fLaC': 'flac', 'Opus': 'opus', '.mp3': 'mp3'});


    for (let i = 0; i < traks.length; i++) {
      const trak = traks[i]
      const stbl = trak.mdia.minf.stbl
      const stsdEntry = stbl.stsd.entries[0]
      const handlerType = trak.mdia.hdlr.handlerType
      let codec
      let mime

      console.log(stsdEntry);

      if (handlerType === 'vide' && vide[stsdEntry.type]) {
        if (this._hasVideo) {
          continue
        }
        this._hasVideo = true


        codec = stsdEntry.type;
        if (stsdEntry.avcC) {
            codec += '.' + stsdEntry.avcC.mimeCodec
        }
        else if (stsdEntry.av1C) {
            codec = stsdEntry.av1C.mimeCodec || codec;
        }
        else if (stsdEntry.vpcC) {
            codec = stsdEntry.vpcC.mimeCodec || codec;
        }
        else if (stsdEntry.hvcC) {
            codec += stsdEntry.hvcC.mimeCodec;
        }

        mime = 'video/mp4; codecs="' + codec + '"';

        console.log(mime);

      } else if (handlerType === 'soun' ) {
        if (this._hasAudio) {
          continue
        }
        this._hasAudio = true


        codec = stsdEntry.type;

        if (stsdEntry.type === 'mp4a') {
            codec = 'mp4a';

            if (stsdEntry.esds && stsdEntry.esds.mimeCodec) {
                codec += '.' + stsdEntry.esds.mimeCodec
            }

            // if (mp3a[codec]) {
            //     // Firefox allows mp3 in mp4 this way
            //     codec = 'mp3'
            // }
        }

        mime = 'audio/mp4; codecs="' + (swap[codec] || codec) + '"';

        console.log(mime);

        
      } else {
        continue
      }

      const samples = []
      let sample = 0

      // Chunk/position data
      let sampleInChunk = 0
      let chunk = 0
      let offsetInChunk = 0
      let sampleToChunkIndex = 0

      // Time data
      let dts = 0
      const decodingTimeEntry = new RunLengthIndex(stbl.stts.entries)
      let presentationOffsetEntry = null
      if (stbl.ctts) {
        presentationOffsetEntry = new RunLengthIndex(stbl.ctts.entries)
      }

      // Sync table index
      let syncSampleIndex = 0

      while (true) {
        var currChunkEntry = stbl.stsc.entries[sampleToChunkIndex]

        // Compute size
        const size = stbl.stsz.entries[sample]

        // Compute time data
        const duration = decodingTimeEntry.value.duration
        const presentationOffset = presentationOffsetEntry ? presentationOffsetEntry.value.compositionOffset : 0

        // Compute sync
        let sync = true
        if (stbl.stss) {
          sync = stbl.stss.entries[syncSampleIndex] === sample + 1
        }

        // Create new sample entry
        const chunkOffsetTable = stbl.stco || stbl.co64
        samples.push({
          size,
          duration,
          dts,
          presentationOffset,
          sync,
          offset: offsetInChunk + chunkOffsetTable.entries[chunk]
        })

        // Go to next sample
        sample++
        if (sample >= stbl.stsz.entries.length) {
          break
        }

        // Move position/chunk
        sampleInChunk++
        offsetInChunk += size
        if (sampleInChunk >= currChunkEntry.samplesPerChunk) {
          // Move to new chunk
          sampleInChunk = 0
          offsetInChunk = 0
          chunk++
          // Move sample to chunk box index
          const nextChunkEntry = stbl.stsc.entries[sampleToChunkIndex + 1]
          if (nextChunkEntry && chunk + 1 >= nextChunkEntry.firstChunk) {
            sampleToChunkIndex++
          }
        }

        // Move time forward
        dts += duration
        decodingTimeEntry.inc()
        presentationOffsetEntry && presentationOffsetEntry.inc()

        // Move sync table index
        if (sync) {
          syncSampleIndex++
        }
      }

      trak.mdia.mdhd.duration = 0
      trak.tkhd.duration = 0

      const defaultSampleDescriptionIndex = currChunkEntry.sampleDescriptionId

      const trackMoov = {
        type: 'moov',
        mvhd: moov.mvhd,
        traks: [{
          tkhd: trak.tkhd,
          mdia: {
            mdhd: trak.mdia.mdhd,
            hdlr: trak.mdia.hdlr,
            elng: trak.mdia.elng,
            minf: {
              vmhd: trak.mdia.minf.vmhd,
              smhd: trak.mdia.minf.smhd,
              dinf: trak.mdia.minf.dinf,
              stbl: {
                stsd: stbl.stsd,
                stts: empty(),
                ctts: empty(),
                stsc: empty(),
                stsz: empty(),
                stco: empty(),
                stss: empty()
              }
            }
          }
        }],
        mvex: {
          mehd: {
            fragmentDuration: moov.mvhd.duration
          },
          trexs: [{
            trackId: trak.tkhd.trackId,
            defaultSampleDescriptionIndex,
            defaultSampleDuration: 0,
            defaultSampleSize: 0,
            defaultSampleFlags: 0
          }]
        }
      }

      this._tracks.push({
        fragmentSequence: 1,
        trackId: trak.tkhd.trackId,
        timeScale: trak.mdia.mdhd.timeScale,
        samples,
        currSample: null,
        currTime: null,
        moov: trackMoov,
        mime
      })
    }

    if (this._tracks.length === 0) {
      this.emit('error', new Error('no playable tracks'))
      return
    }

    // Must be set last since this is used above
    moov.mvhd.duration = 0

    this._ftyp = {
      type: 'ftyp',
      brand: 'iso5',
      brandVersion: 0,
      compatibleBrands: [
        'iso5'
      ]
    }

    const ftypBuf = Box.encode(this._ftyp)
    const data = this._tracks.map(track => {
      const moovBuf = Box.encode(track.moov)
      return {
        mime: track.mime,
        init: Buffer.concat([ftypBuf, moovBuf])
      }
    })

    this.emit('ready', data)
  }

  seek (time) {
    if (!this._tracks) {
      throw new Error('Not ready yet; wait for \'ready\' event')
    }

    if (this._fileStream) {
      this._fileStream.destroy()
      this._fileStream = null
    }

    let startOffset = -1
    this._tracks.map((track, i) => {
      // find the keyframe before the time
      // stream from there
      if (track.outStream) {
        track.outStream.destroy()
      }
      if (track.inStream) {
        track.inStream.destroy()
        track.inStream = null
      }
      const outStream = track.outStream = mp4.encode()
      const fragment = this._generateFragment(i, time)
      if (!fragment) {
        return outStream.finalize()
      }

      if (startOffset === -1 || fragment.ranges[0].start < startOffset) {
        startOffset = fragment.ranges[0].start
      }

      const writeFragment = (frag) => {
        if (outStream.destroyed) return
        outStream.box(frag.moof, err => {
          if (err) return this.emit('error', err)
          if (outStream.destroyed) return
          const slicedStream = track.inStream.slice(frag.ranges)
          slicedStream.pipe(outStream.mediaData(frag.length, err => {
            if (err) return this.emit('error', err)
            if (outStream.destroyed) return
            const nextFrag = this._generateFragment(i)
            if (!nextFrag) {
              return outStream.finalize()
            }
            writeFragment(nextFrag)
          }))
        })
      }
      writeFragment(fragment)
    })

    if (startOffset >= 0) {
      const fileStream = this._fileStream = this._file.createReadStream({
        start: startOffset
      })

      this._tracks.forEach(track => {
        track.inStream = new RangeSliceStream(startOffset, {
          // Allow up to a 10MB offset between audio and video,
          // which should be fine for any reasonable interleaving
          // interval and bitrate
          highWaterMark: 10000000
        })
        fileStream.pipe(track.inStream)
      })
    }

    return this._tracks.map(track => {
      return track.outStream
    })
  }

  _findSampleBefore (trackInd, time) {
    const track = this._tracks[trackInd]
    const scaledTime = Math.floor(track.timeScale * time)
    let sample = bs(track.samples, scaledTime, (sample, t) => {
      const pts = sample.dts + sample.presentationOffset// - track.editShift
      return pts - t
    })
    if (sample === -1) {
      sample = 0
    } else if (sample < 0) {
      sample = -sample - 2
    }
    // sample is now the last sample with dts <= time
    // Find the preceeding sync sample
    while (!track.samples[sample].sync) {
      sample--
    }
    return sample
  }

  _generateFragment (track, time) {
    /*
        1. Find correct sample
        2. Process backward until sync sample found
        3. Process forward until next sync sample after MIN_FRAGMENT_DURATION found
        */
    const currTrack = this._tracks[track]
    let firstSample
    if (time !== undefined) {
      firstSample = this._findSampleBefore(track, time)
    } else {
      firstSample = currTrack.currSample
    }

    if (firstSample >= currTrack.samples.length) { return null }

    const startDts = currTrack.samples[firstSample].dts

    let totalLen = 0
    const ranges = []
    for (var currSample = firstSample; currSample < currTrack.samples.length; currSample++) {
      const sample = currTrack.samples[currSample]
      if (sample.sync && sample.dts - startDts >= currTrack.timeScale * MIN_FRAGMENT_DURATION) {
        break // This is a reasonable place to end the fragment
      }

      totalLen += sample.size
      const currRange = ranges.length - 1
      if (currRange < 0 || ranges[currRange].end !== sample.offset) {
        // Push a new range
        ranges.push({
          start: sample.offset,
          end: sample.offset + sample.size
        })
      } else {
        ranges[currRange].end += sample.size
      }
    }

    currTrack.currSample = currSample

    return {
      moof: this._generateMoof(track, firstSample, currSample),
      ranges,
      length: totalLen
    }
  }

  _generateMoof (track, firstSample, lastSample) {
    const currTrack = this._tracks[track]

    const entries = []
    let trunVersion = 0
    for (let j = firstSample; j < lastSample; j++) {
      const currSample = currTrack.samples[j]
      if (currSample.presentationOffset < 0) { trunVersion = 1 }
      entries.push({
        sampleDuration: currSample.duration,
        sampleSize: currSample.size,
        sampleFlags: currSample.sync ? 0x2000000 : 0x1010000,
        sampleCompositionTimeOffset: currSample.presentationOffset
      })
    }

    const moof = {
      type: 'moof',
      mfhd: {
        sequenceNumber: currTrack.fragmentSequence++
      },
      trafs: [{
        tfhd: {
          flags: 0x20000, // default-base-is-moof
          trackId: currTrack.trackId
        },
        tfdt: {
          baseMediaDecodeTime: currTrack.samples[firstSample].dts
        },
        trun: {
          flags: 0xf01,
          dataOffset: 8, // The moof size has to be added to this later as well
          entries,
          version: trunVersion
        }
      }]
    }

    // Update the offset
    moof.trafs[0].trun.dataOffset += Box.encodingLength(moof)

    return moof
  }
}

class RunLengthIndex {
  constructor (entries, countName) {
    this._entries = entries
    this._countName = countName || 'count'
    this._index = 0
    this._offset = 0

    this.value = this._entries[0]
  }

  inc () {
    this._offset++
    if (this._offset >= this._entries[this._index][this._countName]) {
      this._index++
      this._offset = 0
    }

    this.value = this._entries[this._index]
  }
}

function empty () {
  return {
    version: 0,
    flags: 0,
    entries: []
  }
}

const MIN_FRAGMENT_DURATION = 1 // second

module.exports = MP4Remuxer






// Extending mp4-box-encoding boxes support...

var UINT32_MAX = Math.pow(2, 32);

Box.boxes.fullBoxes.co64 = true;
Box.boxes.co64 = Box.boxes.co64 || {};
Box.boxes.co64.decode = function(buf, offset) {
    buf = buf.slice(offset);
    var num = buf.readUInt32BE(0);
    var entries = new Array(num);

    for (var i = 0; i < num; i++) {
        var pos = i * 8 + 4;
        var hi = buf.readUInt32BE(pos);
        var lo = buf.readUInt32BE(pos + 4);
        entries[i] = (hi * UINT32_MAX) + lo;
    }

    return {
        entries: entries
    }
};

Box.boxes.av1C = {};
Box.boxes.av1C.encode = function _(box, buf, offset) {
    buf = buf ? buf.slice(offset) : Buffer.allocUnsafe(box.buffer.length);
    box.buffer.copy(buf);
    _.bytes = box.buffer.length;
};
Box.boxes.av1C.decode = function (buf, offset, end) {
    // https://aomediacodec.github.io/av1-isobmff/#codecsparam
    var p = 0;
    var r = Object.create(null);
    var readUint8 = function() {
        return buf.readUInt8(p++);
    };
    buf = buf.slice(offset, end);

    var tmp = readUint8();
    this.version = tmp & 0x7F;

    if ((tmp >> 7) & 1 !== 1) {
        console.warn('Invalid av1C marker.');
    }
    else if (this.version !== 1) {
        console.warn('Unsupported av1C version %d.', this.version);
    }
    else {
        tmp = readUint8();
        r.seq_profile = (tmp >> 5) & 7;
        r.seq_level_idx_0 = tmp & 0x1f;
        tmp = readUint8();
        r.seq_tier_0 = (tmp >> 7) & 1;
        r.high_bitdepth = (tmp >> 6) & 1;
        r.twelve_bit = (tmp >> 5) & 1;
        r.monochrome = (tmp >> 4) & 1;
        r.chroma_subsampling_x = (tmp >> 3) & 1;
        r.chroma_subsampling_y = (tmp >> 2) & 1;
        r.chroma_sample_position = (tmp & 3);
        tmp = readUint8();
        r.reserved = (tmp >> 5) & 7;
        r.buffer = Buffer.from(buf);
        tmp = r.high_bitdepth;
        if (tmp < 10) tmp = 8;
        r.mimeCodec = [
            'av01',
            r.seq_profile,
            ('0' + r.seq_level_idx_0).slice(-2) + (!r.seq_tier_0 ? 'M' : 'H'),
            ('0' + tmp).slice(-2)
        ].join('.');
    }
    return r;
};
Box.boxes.av1C.encodingLength = function (box) {
    return box.buffer.length;
};
Box.boxes.av01 = Box.boxes.VisualSampleEntry;

Box.boxes.vpcC = {};
Box.boxes.vpcC.encode = function _(box, buf, offset) {
    buf = buf ? buf.slice(offset) : Buffer.allocUnsafe(box.buffer.length);
    box.buffer.copy(buf);
    _.bytes = box.buffer.length;
};
Box.boxes.vpcC.decode = function(buf, offset, end) {
    // https://www.webmproject.org/vp9/mp4/
    var p = 0;
    var r = Object.create(null);
    var readUint8 = function() {
        return buf.readUInt8(p++);
    };
    var readUint8Array = function(len) {
        var out = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            out[i] = readUint8();
        }
        return out;
    };
    var readUint16 = function() {
        var v = buf.readUInt16BE(p);
        p += 2;
        return v;
    };
    buf = buf.slice(offset, end);

    var tmp = readUint8();
    this.version = tmp & 0x7F;

    if (this.version !== 1) {
        console.warn('Unsupported/deprecated vpcC version %d.', this.version);
    }
    else {
        p += 3; // XXX: out of spec, find it out..
        r.profile = readUint8();
        r.level = readUint8();
        tmp = readUint8();
        r.bitDepth = tmp >> 4;
        r.chromaSubsampling = (tmp >> 1) & 7;
        r.videoFullRangeFlag = tmp & 1;
        // r.colourPrimaries = readUint8();
        // r.transferCharacteristics = readUint8();
        // r.matrixCoefficients = readUint8();
        // r.codecIntializationDataSize = readUint16();
        // r.codecIntializationData = readUint8Array(r.codecIntializationDataSize);
        r.buffer = Buffer.from(buf);
        r.mimeCodec = [
            'vp09',
            ('0' + r.profile).slice(-2),
            ('0' + r.level).slice(-2),
            ('0' + r.bitDepth).slice(-2)
        ].join('.');
    }
    return r;
};
Box.boxes.vpcC.encodingLength = function(box) {
    return box.buffer.length;
};
Box.boxes.vp09 = Box.boxes.VisualSampleEntry;

Box.boxes.hvcC = {};
Box.boxes.hvcC.encode = function _(box, buf, offset) {
    buf = buf ? buf.slice(offset) : Buffer.allocUnsafe(box.buffer.length);
    box.buffer.copy(buf);
    _.bytes = box.buffer.length;
};
Box.boxes.hvcC.decode = function(buf, offset, end) {
    // https://www.iso.org/standard/65216.html
    var p = 0;
    var r = Object.create(null);
    var readUint8 = function() {
        return buf.readUInt8(p++);
    };
    var readUint8Array = function(len) {
        var out = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
            out[i] = readUint8();
        }
        return out;
    };
    var readUint16 = function() {
        var v = buf.readUInt16BE(p);
        p += 2;
        return v;
    };
    var readUint32 = function() {
        var v = buf.readUInt32BE(p);
        p += 4;
        return v;
    };
    buf = buf.slice(offset, end);

    var tmp = readUint8();
    this.version = tmp & 0xFF;
    r.configurationVersion = this.version;

    tmp = readUint8();
    r.profile_space = tmp >> 6;
    r.tier_flag = (tmp & 32) >> 5;
    r.profile_idc = (tmp & 0x1f);
    r.profile_compatibility_indications = readUint32();
    r.constraint_indicator_flags = readUint8Array(6);
    r.level_idc = readUint8();
    r.min_spatial_segmentation_idc = readUint16() & 0xfff;
    r.parallelismType = (readUint8() & 3);
    r.chromaFormat = (readUint8() & 3);
    r.bitDepthLumaMinus8 = (readUint8() & 7);
    r.bitDepthChromaMinus8 = (readUint8() & 7);
    r.avgFrameRate = readUint16();

    tmp = readUint8();
    r.constantFrameRate = (tmp >> 6);
    r.numTemporalLayers = (tmp & 13) >> 3;
    r.temporalIdNested = (tmp & 4) >> 2;
    r.lengthSizeMinusOne = (tmp & 3);
    r.buffer = Buffer.from(buf);

    // e.g. 'hvc1.1.6.L93.90';
    var mime = '.';
    if (r.profile_space) {
        mime += String.fromCharCode(64 + r.profile_space);
    }
    mime += r.profile_idc + '.';

    tmp = 0;
    var j = 0, cpl = r.profile_compatibility_indications;
    while (true) {
        tmp = cpl & 1;
        if (++j > 30) {
            break;
        }
        tmp <<= 1;
        cpl >>= 1;
    }
    mime += tmp.toString(16) + '.' + (r.tier_flag ? 'H' : 'L') + r.level_idc;

    tmp = '';
    cpl = r.constraint_indicator_flags;
    for (j = 5; j >= 0; j--) {
        if (cpl[j] || tmp) {
            tmp = '.' + ('0' + Number(cpl[j]).toString(16)).slice(-2) + tmp;
        }
    }
    r.mimeCodec = mime + tmp;
    return r;
};
Box.boxes.hvcC.encodingLength = function(box) {
    return box.buffer.length;
};
Box.boxes.hev1 = Box.boxes.VisualSampleEntry;
Box.boxes.hvc1 = Box.boxes.VisualSampleEntry;

Box.boxes.fullBoxes.sidx = true;
Box.boxes.sidx = {};
Box.boxes.sidx.decode = function(buf, offset) {
    var r = Object.create(null);
    var p = offset + 4, time;

    var readUInt16 = function() {
        var v = buf.readUInt16BE(p);
        p += 2;
        return v;
    };
    var readUInt32 = function() {
        var v = buf.readUInt32BE(p);
        p += 4;
        return v;
    };
    var readUInt64 = function() {
        var hi = readUInt32();
        var lo = readUInt32();
        return (hi * UINT32_MAX) + lo;
    };

    r.referenceId = readUInt32();
    r.timescale = readUInt32();

    if (this.version === 0) {
        r.earliestPresentationTime = readUInt32();
        r.firstOffset = readUInt32();
    }
    else {
        r.earliestPresentationTime = readUInt64();
        r.firstOffset = readUInt64();
    }

    readUInt16(); // skip reserved
    r.count = readUInt16();
    r.entries = new Array(r.count);

    time = r.earliestPresentationTime;
    offset = this.length + r.firstOffset;

    for (var i = 0; i < r.count; i++) {
        var e = r.entries[i] = Object.create(null);
        var t = readUInt32();
        e.type = (t >>> 31) & 1;
        e.size = t & 0x7fffffff;
        e.duration = readUInt32();

        t = readUInt32();
        e.sap = (t >>> 31) & 1;
        e.sapType = (t >>> 28) & 0x7;
        e.sapDelta = t & 0xfffffff;

        // for an exact byte-offset on disk we need to add the size for ftyp+moov
        e.byteOffset = [offset, offset + e.size - 1];
        e.timeOffset = [time, time / r.timescale, e.duration / r.timescale];

        offset += e.size;
        time += e.duration;
    }

    return r;
};

Box.boxes.AudioSampleEntry.decode = function(buf, offset, end) {
    buf = buf.slice(offset, end);
    var length = end - offset;
    var box = {
        dataReferenceIndex: buf.readUInt16BE(6),
        channelCount: buf.readUInt16BE(16),
        sampleSize: buf.readUInt16BE(18),
        sampleRate: buf.readUInt32BE(24),
        children: []
    };

    var ptr = 28;
    while (length - ptr >= 8) {
        var child = Box.decode(buf, ptr, length);
        if (!child.length) break; // BUGFIX: prevent endless loop with QT videos - FIXME
        box.children.push(child);
        box[child.type] = child;
        ptr += child.length;
    }

    return box
};

Box.boxes.stsz.decode = function(buf, offset) {
    buf = buf.slice(offset)
    var size = buf.readUInt32BE(0)
    var num = buf.readUInt32BE(4)
    var entries = []

    if (size === 0) {
        entries = new Array(num)

        for (var i = 0; i < num; i++) {
            entries[i] = buf.readUInt32BE(i * 4 + 8)
        }
    }

    return {
        sample_size: size,
        sample_count: num,
        entries: entries
    }
};
