/* global Croquet */
import nrrdBrain from "../assets/DAS-T1-study-1-series-3-masked.nrrd";
import nrrdSkull from "../assets/DAS-T1-study-1-series-3-skull.nrrd";

const { Model, View, App, Messenger, Session } = Croquet;
const THREE = require("three");
window.THREE = THREE;

const { GUI } = require('../thirdparty/dat.gui.min');
const extraGuiStyle = document.createElement('style');
const TOUCH = 'ontouchstart' in document.documentElement;
const controlResizer =
    TOUCH ? `
        @media screen and ( max-width: 768px ) {
            #gui-container {
                transform: scale(1.5, 1.75);
            }
        }
    ` : ``;
extraGuiStyle.innerHTML = `
    ${controlResizer}
    .dg.ac {
        -moz-user-select: none;
        -webkit-user-select: none;
        -ms-user-select: none;
        user-select: none;
        z-index: 2;
    }
    .dg.main .close-button.close-bottom {
        background: #666;
    }
    .dg li:not(.folder) {
        background: #666;
    }
    .dg .cr.function:hover, .dg .cr.boolean:hover {
        background: #666;
    }
    .dg .cr.number {
        border-left: none;
    }
    .dg .cr.boolean {
        border-left: none;
    }
    .dg .croquet-slider-li .property-name {
        width: 25%;
    }
    .dg .croquet-button-li {
        box-sizing: border-box;
        display: inline-block;
    }
    .dg .croquet-button-li .property-name {
        width: 50%;
    }
    .dg .croquet-button-li .c {
        width: 50%;
    }
    .dg .c {
        width: 75%;
    }
    .dg .slider {
        margin-left: 0;
        width: 70%;
    }
    .dg .has-slider input[type=text] {
        width: 25%;
        pointer-events: none;
        -moz-user-select: none;
        -webkit-user-select: none;
        -ms-user-select: none;
        user-select: none;
    }
    .dg .c input[type=checkbox] {
        margin-top: 1px;
        width: 25px;
        height: 25px;
    }
    .dg .c input[type=checkbox]:focus { outline: 0; }
    button.slice-mover {
        position: absolute;
        display: inline-block;
        width: 39%;
        height: 23px;
        top: 2px;
        font: 600 14px sans-serif;
        background: #888;
        color: #fff;
        border-radius: 8px;
    }
    button.slice-mover:focus { outline: 0; }
    button.slice-mover.highlight-ahead { color: #ff0 }
    button.slice-mover.highlight-jump { background: #880 }
    div.button-holder {
        background: #666;
        position: absolute;
        width: 31%;
        height: 27px;
        right: 0px;
        display: inline-block;
    }
    .dg ul.closed div.button-holder {
        display: none;
    }
    .dg ul.closed button.slice-mover {
        display: none;
    }
`;
document.head.appendChild(extraGuiStyle);

const { Zlib } = require("../thirdparty/gunzip.module.min.js");
window.Zlib = Zlib;

require('../thirdparty/three/OrbitControls');
require('../thirdparty/three/NRRDLoader');
require('../thirdparty-patched/three/VolumeShader');
require('../thirdparty/three/Volume');

const MAX_INTENSITY = 894; // for the files we're using

const TPS = "10";             // reflector ticks per sec x local multiplier
const THROTTLE = 1000 / 15;   // UI event throttling
const RENDER_THROTTLE = TOUCH ? 125 : 100;

// app configuration: whether to process user events before they're reflected.
// doing so gives faster feedback for the person driving the events, but means
// that other users' screens will update noticeably later (by the current reflector
// round-trip latency).  for demo purposes, having all update together (i.e., local
// update set to false) is arguably more impressive.
const INSTANT_LOCAL_UPDATE = true;

class BrainModel extends Model {
    static types() {
        return {
            "THREE.Vector3": THREE.Vector3,
            "THREE.Quaternion": THREE.Quaternion,
        };
    }

    init(options) {
        super.init(options);

        this.cameraPos = null;
        this.cameraQuat = null;
        this.cameraZoom = null;
        this.slice = null;
        this.nextStrokeIndex = 0;
        this.strokesInProgress = {}; // userId => index
        this.strokes = {}; // index => { slice, points }
        this.subscribe("brain", "moveCamera", this.moveCamera);
        this.subscribe("brain", "selectSlice", this.selectSlice);
        this.subscribe("brain", "extendStroke", this.extendStroke);
        this.subscribe("brain", "endStroke", this.endStroke);
        this.subscribe("brain", "deleteStroke", this.deleteStroke);
    }

    moveCamera(data) {
        if (!this.cameraPos) this.cameraPos = new THREE.Vector3();
        this.cameraPos.set(...data.pos);
        if (!this.cameraQuat) this.cameraQuat = new THREE.Quaternion();
        this.cameraQuat.set(...data.quat);
        this.cameraZoom = data.zoom;
        this.publish("brain", "cameraMoved", data);
    }

    selectSlice(data) {
        this.slice = data.slice;
        this.publish("brain", "sliceSelected", data);
    }

    extendStroke(data) {
        const { userId, point, slice } = data;
        let index = this.strokesInProgress[userId];
        if (index === undefined) {
            index = this.strokesInProgress[userId] = this.nextStrokeIndex++;
            this.strokes[index] = { slice, points: [ point ] };
        } else this.strokes[index].points.push(point);
    }

    endStroke(data) {
        const { userId } = data;
        delete this.strokesInProgress[userId];
    }

    deleteStroke(index) {
        delete this.strokes[index]; // assuming it was still there
    }
}
BrainModel.register("BrainModel");

const sceneSpec = {
    inDrawingMode: false,
    drawingOverridden: false,
    strokePaths: {}, // stroke index => { slice, curvePath, strokeParts }
    };
window.sceneSpec = sceneSpec; // @@ for debug only
function setUpScene() {
    return new Promise(resolve => {
        // adapted from https://threejs.org/examples/webgl2_materials_texture3d.html
        const scene = new THREE.Scene();

        // Create renderer
        const container = document.getElementById('container');
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('webgl2', { antialias: false });
        const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(renderer.domElement);

        let needsRender = false;
        let lastRender = 0;
        sceneSpec.render = () => {
            const now = Date.now();
            if (needsRender && now - lastRender > RENDER_THROTTLE) {
                Object.values(sceneSpec.strokePaths).forEach(spec => {
                    const { slice, strokeParts, centerLine } = spec;
                    const visible = slice === volconfig.slice;
                    if (strokeParts) strokeParts.forEach(mesh => mesh.visible = visible);
                    if (centerLine) centerLine.visible = visible; // ...though opacity is 0 anyway.  this just determines ray-testability.
                    });
                renderer.render(scene, camera);
                needsRender = false;
                lastRender = now;
            }
            };

        let transparent = null;
        const transparencyHandler = sceneSpec.transparencyHandler = newTrans => {
            if (newTrans === transparent) return;

            console.log(`setting transparency: ${newTrans}`);
            renderer.setClearColor(0x000000, newTrans ? 0 : 1);
            transparent = newTrans;
            needsRender = true;
        };
        transparencyHandler(false);

        // create camera
        const h = 300; // frustum height - i.e., the image of an object this tall will take up whole vertical extent of window
        const camera = sceneSpec.camera = new THREE.OrthographicCamera(-h / 2, h / 2, h / 2, -h / 2, 1, 1000); // left & right will be adjusted to suit window
        // camera.up.set(0, 0, 1); // In our data, z is up
        camera.up.set(0, -1, 0); // ael - not in *our* data, apparently
        onWindowResize();

        // create a dummy camera that will be moved by the OrbitControls
        const cameraAvatar = sceneSpec.cameraAvatar = camera.clone();

        // create controls
        const controls = new THREE.OrbitControls(cameraAvatar, renderer.domElement);
        controls.enablePan = false;
        controls.addEventListener('change', () => sceneSpec.handleControlChange && sceneSpec.handleControlChange());
        controls.minZoom = 0.5;
        controls.maxZoom = 4;

        // @@ the image settings were found by trial and error on the brain volume
        // alone, so fudge them to work with the combined intensity range we're now using
        const INTENSITY_FUDGE = 667 / 894;
        // render parameters
        const volconfig = {
            clim1: 0,
            clim2: 0.45 * INTENSITY_FUDGE,
            isothreshold: 0.17 * INTENSITY_FUDGE,
            isosteps: 5,
            isocutoff: 0.26 * INTENSITY_FUDGE,
            colormap: 'gray',
            slice: 0, // will be filled in once we load the volume(s)
            slicesteps: 2,
            slicethreshold: 0.08,
            slicevisible: false,
            skull: true,
            draw: false,

            // for debug/tuning
            test: false,
            test2: false,
            trigger: 1
            };

        // Load the data ...
        const loadPromises = [ [ "brain", nrrdBrain ], [ "skull", nrrdSkull ] ].map(([ volName, url ]) => {
            return new Promise(resolve2 => new THREE.NRRDLoader().load(url, vol => resolve2([ volName, vol ])));
            });
        Promise.all(loadPromises).then(namedVols => {
            console.log("data loaded");

            let xl, yl, zl; // set in processVolume - should be identical for both volumes

            // zClipSense determines which part of the volume will be discarded, so
            // that the slice is always in front.  the view sets it every time the
            // camera is moved.
            let zClipSense = 1;
            sceneSpec.setClipSense = () => {
                zClipSense = camera.position.z < zl / 2 ? -1 : 1;

                for (const spec of Object.values(volSpecs)) {
                    spec.volUniforms["u_clipz"].value = volconfig.slice * zClipSense;
                    spec.sliceUniforms["u_zclipsense"].value = zClipSense; // used to tell which direction to plumb for extra layers
                }

                needsRender = true;
                };

            sceneSpec.applySliceSelection = slice => {
                volconfig.slice = slice;
                const visible = volconfig.slicevisible = !(slice === 0 || slice === zl);

                for (const [volName, spec] of Object.entries(volSpecs)) {
                    spec.volUniforms["u_clipz"].value = slice * zClipSense;

                    spec.sliceMesh.visible = visible && (volName !== 'skull' || volconfig.skull);
                    if (visible) {
                        const array = spec.sliceGeo.attributes.position.array;
                        for (let i = 2; i < array.length; i += 3) array[i] = slice;
                        spec.sliceGeo.attributes.position.needsUpdate = true;
                    }
                }

                updateSliceButtons();
                needsRender = true;
                };

            const volSpecs = {};
            namedVols.forEach(([ volName, vol ]) => volSpecs[volName] = processVolume(volName, vol, MAX_INTENSITY));

            sceneSpec.volumeLengths = new THREE.Vector3(xl, yl, zl);

            // gui for interaction
            const gui = new GUI({ autoPlace: false });
            const customContainer = document.getElementById('gui-container');
            customContainer.appendChild(gui.domElement);
            const slicer = gui.add(volconfig, 'slice', 0, zl, 1).onChange(updateSlice).listen().domElement;
            const sliceLI = slicer.parentElement.parentElement;
            sliceLI.classList.add('croquet-slider-li');
            const sliceDiv = document.createElement('div');
            sliceLI.parentElement.appendChild(sliceDiv);
            sliceDiv.style.width = "100%";
            sliceDiv.appendChild(sliceLI); // move into the new parent
            sliceLI.style.width = "66%"; // and use only a portion of it
            //const label = sliceLI.querySelector()
            sliceLI.style.display = "inline-block";

            const butDiv = document.createElement('div');
            butDiv.classList.add("button-holder");
            sliceDiv.appendChild(butDiv);

            const but = document.createElement('button');
            but.id = "prev-slice";
            but.classList.add("slice-mover");
            but.textContent = "<";
            but.style.left = "7%";
            but.onclick = prevSlice;
            butDiv.appendChild(but);

            const but2 = document.createElement('button');
            but2.id = "next-slice";
            but2.classList.add("slice-mover");
            but2.textContent = ">";
            but2.style.right = "7%";
            but2.onclick = nextSlice;
            butDiv.appendChild(but2);

            const skullSwitch = gui.add(volconfig, 'skull').onChange(toggleSkull).domElement;
            const skullLI = skullSwitch.parentElement.parentElement;
            skullLI.classList.add('croquet-button-li');
            const switchDiv = document.createElement('div');
            switchDiv.style.width = "100%";
            skullLI.parentElement.appendChild(switchDiv);
            switchDiv.appendChild(skullLI); // move into the new parent
            skullLI.style.width = "50%"; // and use only a portion of it

            const drawSwitch = gui.add(volconfig, 'draw').onChange(tentativelyToggleDraw).listen().domElement;
            const drawLI = drawSwitch.parentElement.parentElement;
            drawLI.classList.add('croquet-button-li');
            switchDiv.appendChild(drawLI); // move into the new parent
            drawLI.style.width = "50%"; // and use only a portion of it
            drawLI.style.left = "50%";
            drawLI.style.borderLeft = "1px solid #333";

            let drawLocked;
            function setDrawLock(bool) {
                drawLocked = bool;
                drawLI.querySelector('.property-name').textContent = bool ? "draw 🔒" : "draw";
            }
            setDrawLock(false);

            const DOUBLE = 275; // max ms to count as double-click
            let lastToggle = 0;
            let offTimer = null;
            function clearTimer() {
                if (offTimer) { clearTimeout(offTimer); offTimer = null; }
                lastToggle = 0;
            }
            function tentativelyToggleDraw(bool) {
                // a double click, starting from either the on or off state, will
                // set drawing ON and add the lock.
                // when starting from OFF, we discard the second toggle
                // (back to OFF) if within the double-click period.
                // when starting from ON, we add a timeout to the initial OFF, only
                // acting on it if no further click has arrived when the timeout expires.
                const now = Date.now();
                if (now - lastToggle < DOUBLE) {
                    clearTimer();
                    volconfig.draw = true;
                    setDrawLock(true);
                    return;
                }

                if (bool) {
                    clearTimer();
                    engageDrawingMode(true);
                } else {
                    setDrawLock(false); // give immediate feedback
                    offTimer = setTimeout(() => {
                        clearTimer();
                        engageDrawingMode(false);
                        }, DOUBLE); // only actually exit drawing if not a double-click
                }

                lastToggle = now;
            }

            //gui.add(volconfig, 'clim1', 0, 1, 0.01).onChange(updateUniforms);
            //gui.add(volconfig, 'clim2', 0, 1, 0.01).onChange(updateUniforms);
            //gui.add(volconfig, 'colormap', { gray: 'gray', viridis: 'viridis' }).onChange(updateUniforms);
            //gui.add(volconfig, 'isothreshold', 0.1, 0.3, 0.01).onChange(updateUniforms);
            //gui.add(volconfig, 'isosteps', 4, 32, 1).onChange(updateUniforms);
            //gui.add(volconfig, 'isocutoff', 0, 1, 0.01).onChange(updateUniforms);
            //gui.add(volconfig, 'slicesteps', 1, 5, 1).onChange(updateUniforms);
            //gui.add(volconfig, 'slicethreshold', 0, 0.2, 0.01).onChange(updateUniforms);

            //gui.add(volconfig, 'test').onChange(updateUniforms);
            //gui.add(volconfig, 'test2').onChange(updateUniforms);
            //gui.add(volconfig, 'trigger', 0.1, 1.0, 0.02).onChange(updateUniforms);

            cameraAvatar.position.set(-xl * 2, yl / 2, zl * 2);
            controls.target.set(xl / 2, yl / 2, zl / 2);
            controls.update();

            camera.position.copy(cameraAvatar.position);
            camera.quaternion.copy(cameraAvatar.quaternion);
            camera.updateMatrixWorld();

            sceneSpec.initialCameraPos = new THREE.Vector3().copy(camera.position);
            sceneSpec.initialCameraQuat = new THREE.Quaternion().copy(camera.quaternion);
            sceneSpec.initialCameraZoom = camera.zoom;

            sceneSpec.setClipSense();
            sceneSpec.applySliceSelection(volSpecs.brain.initialSlice);
            sceneSpec.initialSlice = volSpecs.brain.initialSlice;

            // shift key forces restoration of OrbitControl manipulation if in draw mode
            // but not actually in the middle of a stroke
            document.addEventListener("keydown", evt => {
                if (evt.key === "Escape") overrideDrawingMode(true);
                });
            document.addEventListener("keyup", evt => {
                if (evt.key === "Escape") overrideDrawingMode(false);
                if (evt.key === "Backspace") deleteHighlightedStroke(); // if one is highlighted
                });

            let isPointerDown = false;
            const reallyDrawing = () => sceneSpec.inDrawingMode && !sceneSpec.drawingOverridden;
            const cont = document.getElementById('container');
            cont.addEventListener('pointerdown', evt => {
                isPointerDown = true;
                if (reallyDrawing()) startStroke(evt);
                });
            cont.addEventListener('pointermove', evt => { if (reallyDrawing()) pointerMove(evt); });
            cont.addEventListener('pointerup', _evt => {
                // always ok to end a stroke
                isPointerDown = false;
                endStroke();
                });

            console.log("scene ready");
            resolve();

            function processVolume(volumeName, volume, maxIntensity) {
                const volSpec = {};

                xl = volume.xLength;
                yl = volume.yLength;
                zl = volume.zLength;
                const initialSlice = volSpec.initialSlice = Math.floor(zl / 2);

                // ael - normalise pixels to the range 0 to 1
/*
if (volume.max !== 1 || volume.min !== 0) {
    const range = volume.max - volume.min;
    for (let i = 0; i < volume.data.length; i++) {
        volume.data[i] = (volume.data[i] - volume.min) / range;
    }
}
*/
                // now we normalise based on the max intensity of either of the loaded volumes
                for (let i = 0; i < volume.data.length; i++) {
                    volume.data[i] = Math.min(1.0, volume.data[i] / maxIntensity);
                }

                // Texture to hold the volume. We have scalars, so we put our data in the red channel.
                // THREEJS will select R32F (33326) based on the THREE.RedFormat and THREE.FloatType.
                // Also see https://www.khronos.org/registry/webgl/specs/latest/2.0/#TEXTURE_TYPES_FORMATS_FROM_DOM_ELEMENTS_TABLE
                const texture = new THREE.DataTexture3D(volume.data, xl, yl, zl);
                texture.format = THREE.RedFormat;
                texture.type = THREE.FloatType;
                // need to check if linear filtering is actually available
                // because otherwise we don't see anything (e.g. on iOS)
                const isLinearFilteringAvailable = context.getExtension('OES_texture_float_linear');
                if (isLinearFilteringAvailable) {
                   texture.minFilter = texture.magFilter = THREE.LinearFilter;
                }
                texture.unpackAlignment = 1;
                texture.needsUpdate = true;

                const volShader = THREE.VolumeRenderShader2;
                const volUniforms = volSpec.volUniforms = THREE.UniformsUtils.clone(volShader.uniforms);
                volUniforms["u_data"].value = texture;
                volUniforms["u_size"].value.set(xl, yl, zl);
                volUniforms["u_clim"].value.set(volconfig.clim1, volconfig.clim2);
                volUniforms["u_renderthreshold"].value = volconfig.isothreshold;
                volUniforms["u_rendersteps"].value = volconfig.isosteps;
                volUniforms["u_rendercutoff"].value = volconfig.isocutoff;
                //volUniforms["u_cmdata"].value = cmtextures[volconfig.colormap];
                volUniforms["u_clipz"].value = initialSlice * zClipSense;
                //volUniforms["u_test"].value = volconfig.test ? 1 : 0;
                //volUniforms["u_test2"].value = volconfig.test2 ? 1 : 0;
                //volUniforms["u_trigger"].value = volconfig.trigger;
                const volMat = new THREE.RawShaderMaterial({
                    uniforms: volUniforms,
                    vertexShader: volShader.vertexShader,
                    fragmentShader: volShader.fragmentShader,
                    side: THREE.BackSide // The volume shader uses the backface as its "reference point"
                    });
                const volGeo = new THREE.BoxBufferGeometry(xl, yl, zl);
                volGeo.translate(xl / 2 - 0.5, yl / 2 - 0.5, zl / 2 - 0.5); // ael - retaining the original 0.5s, which i assume help somehow.  sharpness?
                const volMesh = volSpec.volMesh = new THREE.Mesh(volGeo, volMat);
                scene.add(volMesh);

                const sliceShader = THREE.SimpleSliceShader; // ael hack
                const sliceUniforms = volSpec.sliceUniforms = THREE.UniformsUtils.clone(sliceShader.uniforms);
                sliceUniforms["u_data"].value = texture;
                sliceUniforms["u_size"].value.set(xl, yl, zl);
                sliceUniforms["u_clim"].value.set(volconfig.clim1, volconfig.clim2);
                sliceUniforms["u_renderthreshold"].value = volumeName === "brain" ? 0.01 : volconfig.slicethreshold;
                sliceUniforms["u_slicesteps"].value = volconfig.slicesteps;
                sliceUniforms["u_zclipsense"].value = zClipSense;
                sliceUniforms["u_test"].value = volconfig.test ? 1 : 0;

                const sliceMat = new THREE.RawShaderMaterial({
                    uniforms: sliceUniforms,
                    vertexShader: sliceShader.vertexShader,
                    fragmentShader: sliceShader.fragmentShader,
                    side: THREE.DoubleSide,
                    transparent: true
                    });
                const sliceGeo = volSpec.sliceGeo = new THREE.PlaneBufferGeometry(xl, yl);
                sliceGeo.translate(xl / 2 - 0.5, yl / 2 - 0.5, zl / 2 - 0.5); // ael - retaining the original 0.5s, which i assume help somehow.  sharpness?
                const sliceMesh = volSpec.sliceMesh = new THREE.Mesh(sliceGeo, sliceMat);
                sliceMesh.croquetClass = `${volumeName}-slice`;
                scene.add(sliceMesh);

                return volSpec;
            }

            function toggleSkull(bool) {
                const skullSpec = volSpecs.skull;
                skullSpec.volMesh.visible = bool;
                skullSpec.sliceMesh.visible = volconfig.slicevisible && bool;
                needsRender = true;
            }

            function updateSlice(slice) {
                if (sceneSpec.handleSliceChange) sceneSpec.handleSliceChange(slice);
                needsRender = true;
            }

            function engageDrawingMode(bool) {
                sceneSpec.inDrawingMode = bool;
                setControlState();
                if (!bool) {
                    if (isPenDown) endStroke(); // exiting drawing mode must terminate any stroke
                    setHighlightedStroke(null);

                    if (sceneSpec.handleResyncAfterDrawing) sceneSpec.handleResyncAfterDrawing();
                }
                updateSliceButtons();
            }
            function overrideDrawingMode(bool) {
                if (bool && isPenDown) return; // can't hijack in middle of a stroke

                sceneSpec.drawingOverridden = bool;
                // if cancelling override, but pointer is down, wait until the pointerup
                // because otherwise the OrbitControls won't see the up.
                if (!(!bool && isPointerDown)) setControlState();
            }
            function setControlState() {
                const drawing = sceneSpec.inDrawingMode && !sceneSpec.drawingOverridden;
                controls.enabled = !drawing; // engage/disengage the OrbitControls
                document.getElementById('container').style.cursor = drawing ? 'crosshair' : '';
            }
            function nextSlice() {
                moveToNextSlice(1, !sceneSpec.inDrawingMode);
            }
            function prevSlice() {
                moveToNextSlice(-1, !sceneSpec.inDrawingMode);
            }
            function moveToNextSlice(direction, preferAnnotated) {
                let slice = volconfig.slice + direction;
                if (slice < 0 || slice > zl) return; // we're at one end or the other

                // if preferAnnotated is true, search for an annotated slice - but if
                // none is found, just step by one as usual.
                if (preferAnnotated) {
                    const fallbackSlice = slice;

                    const annotatedSlices = {};
                    const paths = sceneSpec.strokePaths;
                    Object.keys(paths).forEach(index => annotatedSlices[paths[index].slice] = true);

                    let found = false;
                    while (!found && slice >= 0 && slice <= zl) {
                        found = !!annotatedSlices[slice];
                        if (!found) slice += direction;
                    }
                    if (!found) slice = fallbackSlice;
                }

                volconfig.slice = slice;
                updateSlice(slice);
            }
            function updateSliceButtons() {
                const currentSlice = volconfig.slice;
                const paths = sceneSpec.strokePaths;
                let lower = false, higher = false;
                Object.keys(paths).forEach(index => {
                    const annotatedSlice = paths[index].slice;
                    if (annotatedSlice < currentSlice) lower = true;
                    if (annotatedSlice > currentSlice) higher = true;
                    });

                const prevClasses = document.getElementById('prev-slice').classList;
                if (lower) prevClasses.add('highlight-ahead'); else prevClasses.remove('highlight-ahead');
                if (lower && !sceneSpec.inDrawingMode) prevClasses.add('highlight-jump');
                else prevClasses.remove('highlight-jump');

                const nextClasses = document.getElementById('next-slice').classList;
                if (higher) nextClasses.add('highlight-ahead'); else nextClasses.remove('highlight-ahead');
                if (higher && !sceneSpec.inDrawingMode) nextClasses.add('highlight-jump');
                else nextClasses.remove('highlight-jump');
            }

            const raycaster = new THREE.Raycaster();
            raycaster.linePrecision = 5;
            const mouse = new THREE.Vector2();
            function findLocation(event, targetClass="brain-slice") {
                // modeled after https://threejs.org/docs/#api/en/core/Raycaster
                mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
                mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
                raycaster.setFromCamera(mouse, camera);
                const intersects = raycaster.intersectObjects(scene.children);
                for (let i = 0; i < intersects.length; i++) {
                    const threeObj = intersects[i].object;
                    if (threeObj.croquetClass === targetClass) return intersects[i];
                }
                return null;
            }

            let isPenDown = false;
            const lastLoc = new THREE.Vector3();
            let lastStrokeTime = 0;
            function startStroke(evt) {
                isPenDown = true;

                announcePointIfNew(evt);
            }
            function pointerMove(evt) {
                if (!isPenDown) {
                    const intersect = findLocation(evt, "annotationStroke");
                    if (intersect) setHighlightedStroke(intersect.object.croquetStrokeIndex);
                    else setHighlightedStroke(null);
                    return;
                }
                const now = Date.now();
                if (now - lastStrokeTime < THROTTLE) return;

                lastStrokeTime = now;
                announcePointIfNew(evt);
            }
            function announcePointIfNew(evt) {
                const intersect = findLocation(evt);
                const loc = intersect && intersect.point;
                if (loc && lastLoc.distanceTo(loc) > 0 && sceneSpec.handleStrokePoint) {
                    lastLoc.copy(loc);
                    sceneSpec.handleStrokePoint(loc, volconfig.slice);
                }
            }
            function endStroke() {
                setControlState(); // might have been postponed during an override
                if (!isPenDown) return; // nothing to end

                isPenDown = false;
                lastLoc.set(0, 0, 0);
                if (!drawLocked) {
                    volconfig.draw = false;
                    engageDrawingMode(false);
                }
                if (sceneSpec.handleStrokeEnd) sceneSpec.handleStrokeEnd();
            }
            const HILITE = new THREE.Color(0xff4444);
            const NON_HILITE = new THREE.Color(0xffff00);
            let highlightedStrokeIndex = null;
            function setHighlightedStroke(indexOrNull) {
                const strokePaths = sceneSpec.strokePaths;
                if (highlightedStrokeIndex !== indexOrNull) {
                    if (highlightedStrokeIndex !== null) strokePaths[highlightedStrokeIndex].strokeParts.forEach(mesh => mesh.material.color.copy(NON_HILITE));
                    highlightedStrokeIndex = indexOrNull;
                    if (highlightedStrokeIndex !== null) strokePaths[highlightedStrokeIndex].strokeParts.forEach(mesh => mesh.material.color.copy(HILITE));
                }
                needsRender = true;
            }

            function deleteHighlightedStroke() {
                if (highlightedStrokeIndex !== null && sceneSpec.handleStrokeDeletion) sceneSpec.handleStrokeDeletion(highlightedStrokeIndex);
            }

            function updateStrokes(modelPaths) {
                const radius = 1, segments = 12;
                const strokePaths = sceneSpec.strokePaths;
                const priorIndices = {};
                Object.keys(strokePaths).forEach(index => priorIndices[index] = true);
                for (const [index, modelPathSpec] of Object.entries(modelPaths)) {
                    delete priorIndices[index]; // still there in the model
                    const { slice, points: modelPath } = modelPathSpec;
                    if (modelPath.length >= 2) { // not interesting until at least two points
                        let spec = strokePaths[index];
                        if (!spec) spec = strokePaths[index] = { slice, curvePath: new THREE.CurvePath() };
                        const curvePath = spec.curvePath;
                        const knownCurves = curvePath.curves;
                        if (modelPath.length > knownCurves.length + 1) {
                            for (let i = knownCurves.length + 1; i < modelPath.length; i++) {
                                curvePath.add(new THREE.LineCurve3(modelPath[i-1], modelPath[i]));
                            }
                            const geometry = new THREE.TubeGeometry(curvePath, Math.min(100, modelPath.length * 3), radius, segments, false);
                            const lineGeometry = new THREE.Geometry().setFromPoints(modelPath);
                            const { strokeParts, centerLine } = spec;
                            if (strokeParts) {
                                const [ strokeMesh, _, endCap ] = strokeParts;
                                strokeMesh.geometry.dispose();
                                strokeMesh.geometry = geometry;
                                endCap.position.copy(modelPath[modelPath.length - 1]);
                                centerLine.geometry.dispose();
                                centerLine.geometry = lineGeometry;
                            } else {
                                const material = new THREE.MeshBasicMaterial({ transparent: true });
                                material.color.copy(NON_HILITE);

                                const strokeMesh = new THREE.Mesh(geometry, material);
                                //strokeMesh.croquetClass = "annotationStroke";
                                //strokeMesh.croquetStrokeIndex = index;
                                scene.add(strokeMesh);

                                const startCap = new THREE.Mesh(new THREE.SphereGeometry(radius), material);
                                startCap.position.copy(modelPath[0]);
                                scene.add(startCap);

                                const endCap = new THREE.Mesh(new THREE.SphereGeometry(radius), material);
                                endCap.position.copy(modelPath[0]);
                                scene.add(endCap);

                                spec.strokeParts = [strokeMesh, startCap, endCap];
                                spec.strokeParts.forEach(mesh => mesh.raycast = () => {});

                                const line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ transparent: true, opacity: 0 }));
                                line.croquetClass = "annotationStroke";
                                line.croquetStrokeIndex = index;
                                scene.add(line);
                                spec.centerLine = line;
                            }
                            needsRender = true;
                        }
                    }
                }
                // any indices that haven't been mentioned must have been deleted
                Object.keys(priorIndices).forEach(index => {
                    const spec = strokePaths[index];
                    const { strokeParts, centerLine } = spec;
                    if (strokeParts) {
                        if (highlightedStrokeIndex === index) highlightedStrokeIndex = null;
                        [...strokeParts, centerLine].forEach(obj => {
                            scene.remove(obj);
                            obj.geometry.dispose();
                            });
                        strokeParts[0].material.dispose(); // shared
                        centerLine.material.dispose();
                    }
                    delete strokePaths[index];
                    needsRender = true;
                    });
                if (needsRender) updateSliceButtons();
            }
            sceneSpec.updateStrokes = updateStrokes;

            function updateUniforms() {
                Object.values(volSpecs).forEach(spec => {
                    const volUniforms = spec.volUniforms;
                    //volUniforms["u_clim"].value.set(volconfig.clim1, volconfig.clim2);
                    //volUniforms["u_renderthreshold"].value = volconfig.isothreshold;
                    volUniforms["u_rendersteps"].value = volconfig.isosteps;
                    //volUniforms["u_rendercutoff"].value = volconfig.isocutoff;
                    //volUniforms["u_cmdata"].value = cmtextures[volconfig.colormap];
                    volUniforms["u_test"].value = volconfig.test ? 1 : 0;
                    volUniforms["u_test2"].value = volconfig.test2 ? 1 : 0;
                    volUniforms["u_trigger"].value = volconfig.trigger;

                    const sliceUniforms = spec.sliceUniforms;
                    //sliceUniforms["u_clim"].value.set(volconfig.clim1, volconfig.clim2);
                    //sliceUniforms["u_slicesteps"].value = volconfig.slicesteps;
                    //sliceUniforms["u_renderthreshold"].value = volconfig.slicethreshold;
                    sliceUniforms["u_test"].value = volconfig.test ? 1 : 0;

                    });
                needsRender = true;
            }
        });

        window.addEventListener('resize', onWindowResize, false);

        function onWindowResize() {
            renderer.setSize(window.innerWidth, window.innerHeight);

            const newAspect = window.innerWidth / window.innerHeight;
            const frustumHeight = camera.top - camera.bottom;
            camera.left = -frustumHeight * newAspect / 2;
            camera.right = frustumHeight * newAspect / 2;

            camera.updateProjectionMatrix();
            needsRender = true;
        }
    });
}

// a throttle that also ensures that the last value is delivered
function throttle(fn, delay) {
    let lastTime = 0;
    let timeoutForFinal = null;
    const clearFinal = () => {
        if (timeoutForFinal) {
            clearTimeout(timeoutForFinal);
            timeoutForFinal = null;
        }
        };
    const runFn = (...args) => {
        clearFinal(); // shouldn't be one, but...
        lastTime = Date.now();
        fn(...args);
        };
    return (...args) => {
        clearFinal();
        const toWait = delay - (Date.now() - lastTime);
        if (toWait < 0) runFn(...args);
        else timeoutForFinal = setTimeout(() => runFn(...args), toWait);
        };
}

class BrainView extends View {

    constructor(model) {
        super(model);

        this.model = model;

        this.subscribe("brain", { event: "cameraMoved", handling: "oncePerFrameWhileSynced" }, this.message_cameraMoved);
        this.subscribe("brain", { event: "sliceSelected", handling: "oncePerFrameWhileSynced" }, this.message_changeSlice);

        this.lastCameraMove = 0;

        sceneSpec.handleControlChange = () => this.cameraAvatarMoved();
        sceneSpec.handleSliceChange = throttle(slice => this.sliceControlMoved(slice), THROTTLE);
        // invocations of handleStrokePoint are already throttled
        sceneSpec.handleStrokePoint = (point, slice) => this.announceStrokePoint(point, slice);
        sceneSpec.handleStrokeEnd = () => this.announceStrokeEnd();
        sceneSpec.handleStrokeDeletion = index => this.announceStrokeDeletion(index);
        sceneSpec.handleResyncAfterDrawing = () => this.resyncAfterDrawing();

        // on initialisation, force sync with the model
        this.syncCameraWithModel();
        this.syncSliceWithModel();

        if (window.parent !== window) {
            // assume that we're embedded in Q
            Messenger.startPublishingPointerMove();

            Messenger.setReceiver(this);
            Messenger.send("appReady");
            Messenger.on("appInfoRequest", () => {
                Messenger.send("appInfo", { appName: "brain", label: "brain", iconName: "tools.svgIcon", urlTemplate: "../brain/?q=${q}" });
                });

            Messenger.on("userCursor", data => window.document.body.style.setProperty("cursor", data));
            Messenger.send("userCursorRequest");

            Messenger.on("transparency", bool => sceneSpec.transparencyHandler(bool));
            Messenger.send("transparencyRequest");
        }

        this.future(500).refreshStrokes();
    }

    // handle a change reported by the OrbitControls, which we've given direct control over
    // a dummy camera.  here we read out where that camera has been moved to, optionally
    // move our local camera to that position instantly, and publish a replicated message
    // that other instances (and this instance, in the non-instant case) will use to move
    // their cameras.
    async cameraAvatarMoved() {
        const now = Date.now();
        if (now - this.lastCameraMove < THROTTLE) return;

        this.lastCameraMove = now;

        const { camera, cameraAvatar } = sceneSpec;
        const pos = new THREE.Vector3().copy(cameraAvatar.position);
        if (INSTANT_LOCAL_UPDATE || sceneSpec.inDrawingMode) { // if in drawing mode, user must be doing an override.  act on the update.
            camera.position.copy(cameraAvatar.position);
            camera.quaternion.copy(cameraAvatar.quaternion);
            camera.zoom = cameraAvatar.zoom;
            camera.updateMatrixWorld();
            camera.updateProjectionMatrix();

            sceneSpec.setClipSense();
        }

        if (!sceneSpec.inDrawingMode) this.publish("brain", "moveCamera", { pos: pos.toArray(), quat: cameraAvatar.quaternion.toArray(), zoom: cameraAvatar.zoom, viewId: this.viewId });
    }

    // someone has published a message that moves the camera.
    // if we're in drawing mode, it won't have been us.  ignore it.
    // otherwise check whether instant update is happening: if so,
    // and this is a message from here, also ignore it.
    message_cameraMoved(data) {
        if (sceneSpec.inDrawingMode || (INSTANT_LOCAL_UPDATE && data.viewId === this.viewId)) return;

        this.syncCameraWithModel(data.viewId);
    }

    syncCameraWithModel(sourceViewId) { // sourceId will be unspecified when exiting drawing mode
        const useInitialValues = this.model.cameraPos === null;

        const { camera, cameraAvatar } = sceneSpec;

        camera.position.copy(useInitialValues ? sceneSpec.initialCameraPos : this.model.cameraPos);
        camera.quaternion.copy(useInitialValues ? sceneSpec.initialCameraQuat : this.model.cameraQuat);
        camera.zoom = useInitialValues ? sceneSpec.initialCameraZoom : this.model.cameraZoom;
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();

        sceneSpec.setClipSense();

        // if viewId is supplied, and it's our viewId, this must be an immediate reflection
        // of a message published from here, triggered by movement of the camera avatar.
        // in that case, don't try to force a new position on the avatar.
        if (sourceViewId !== this.viewId) {
            cameraAvatar.position.copy(camera.position);
            cameraAvatar.quaternion.copy(camera.quaternion);
            cameraAvatar.zoom = camera.zoom;
            cameraAvatar.updateMatrixWorld();
        }
    }

    // this is already debounced
    sliceControlMoved(slice) {
        if (INSTANT_LOCAL_UPDATE || sceneSpec.inDrawingMode) sceneSpec.applySliceSelection(slice);

        if (!sceneSpec.inDrawingMode) this.publish("brain", "selectSlice", { slice, viewId: this.viewId });
    }

    message_changeSlice(data) {
        if (sceneSpec.inDrawingMode || (INSTANT_LOCAL_UPDATE && data.viewId === this.viewId)) return;

        this.syncSliceWithModel();
    }

    syncSliceWithModel() {
        let slice = this.model.slice;
        if (slice === null) slice = sceneSpec.initialSlice;
        sceneSpec.applySliceSelection(slice);
    }

    resyncAfterDrawing() {
        this.syncCameraWithModel();
        this.syncSliceWithModel();
    }

    announceStrokePoint(point, slice) {
        this.publish("brain", "extendStroke", { userId: this.viewId, point, slice });
    }

    announceStrokeEnd() {
        this.publish("brain", "endStroke", { userId: this.viewId });
    }

    announceStrokeDeletion(index) {
        this.publish("brain", "deleteStroke", index);
    }

    refreshStrokes() {
        sceneSpec.updateStrokes(this.model.strokes);

        this.future(100).refreshStrokes();
    }

    detach() {
        super.detach();
        delete sceneSpec.handleControlChange;
        delete sceneSpec.handleSliceChange;
    }
}

async function go() {
    // get all the data loaded and prepped before we even attempt to start the session
    await setUpScene();

    App.messages = true;
    App.makeWidgetDock();

    const session = await Session.join({
        apiKey: '1_i65fcn11n7lhrb5n890hs3dhj11hfzfej57pvlrx',
        appId: "io.croquet.brain",
        name: App.autoSession(),
        password: App.autoPassword(),
        model: BrainModel,
        view: BrainView,
        tps: TPS,
        step: "manual"
        });

    window.requestAnimationFrame(frame);
    function frame(timestamp) {
        session.step(timestamp);

        if (session.view) sceneSpec.render();

        window.requestAnimationFrame(frame);
    }
}

go();
