/**
 * Created by ghassaei on 10/7/16.
 */

function initDynamicSolver(globals){

    globals.gpuMath = initGPUMath();

    var nodes;
    var edges;
    var faces;
    var creases;
    var positions;
    var colors;

    var originalPosition;
    var position;
    var lastPosition;
    var lastLastPosition;//for verlet integration
    var velocity;
    var lastVelocity;
    var externalForces;
    var mass;
    var meta;//[beamMetaIndex, numBeams, nodeCreaseMetaIndex, numCreases]
    var meta2;//[nodeFaceMetaIndex, numFaces]
    var beamMeta;//[K, D, length, otherNodeIndex]

    var normals;
    var faceVertexIndices;//[a,b,c] textureDimFaces
    var nominalTriangles;//[angleA, angleB, angleC]
    var nodeFaceMeta;//[faceIndex, a, b, c] textureNodeFaces
    var creaseMeta;//[k, d, targetTheta, -] textureDimCreases
    var creaseMeta2;//[node1Index, node2Index, node3index, node4index]//nodes 1 and 2 are opposite crease, 3 and 4 are on crease, textureDimCreases
    var nodeCreaseMeta;//[creaseIndex (thetaIndex), nodeIndex (1/2/3/4), -, -] textureDimNodeCreases
    var creaseGeo;//[h1, h2, coef1, coef2]
    var creaseVectors;//indices of crease nodes
    var theta;//[theta, w, normalIndex1, normalIndex2]
    var lastTheta;//[theta, w, normalIndex1, normalIndex2]

    let avgOriginalPosition;

    let $edgeNumberOutput = $("#edgeNum");
    let $vertexNumberOutput = $("#vertNum");
    let $faceNumberOutput = $("#faceNum");

    function syncNodesAndEdges(){
        nodes = globals.model.getNodes();
        $vertexNumberOutput.html(nodes.length);
        edges = globals.model.getEdges();
        $edgeNumberOutput.html(edges.length);
        faces = globals.model.getFaces();
        $faceNumberOutput.html(faces.length);
        creases = globals.model.getCreases();

        positions = globals.model.getPositionsArray();
        colors = globals.model.getColorsArray();

        initTypedArrays();
        initTexturesAndPrograms(globals.gpuMath);
        setSolveParams();

        avgOriginalPosition = getAvgOriginalPosition();
    }

    function getAvgOriginalPosition(){
        let orgxavg = 0, orgyavg = 0, orgzavg = 0;
        for (let i = 0; i < nodes.length; i++) {
            orgxavg += originalPosition[4*i];
            orgyavg += originalPosition[4*i+1];
            orgzavg += originalPosition[4*i+2];
        }
        let avgOriginalPosition = new THREE.Vector3(orgxavg, orgyavg, orgzavg);
        avgOriginalPosition.multiplyScalar(1/nodes.length);
        return avgOriginalPosition;
    }

    var programsInited = false;//flag for initial setup

    var textureDim = 0;
    var textureDimEdges = 0;
    var textureDimFaces = 0;
    var textureDimCreases = 0;
    var textureDimNodeCreases = 0;
    var textureDimNodeFaces = 0;

    function reset(){
        globals.gpuMath.step("zeroTexture", [], "u_position");
        globals.gpuMath.step("zeroTexture", [], "u_lastPosition");
        globals.gpuMath.step("zeroTexture", [], "u_lastLastPosition");
        globals.gpuMath.step("zeroTexture", [], "u_velocity");
        globals.gpuMath.step("zeroTexture", [], "u_lastVelocity");
        globals.gpuMath.step("zeroThetaTexture", ["u_lastTheta"], "u_theta");
        globals.gpuMath.step("zeroThetaTexture", ["u_theta"], "u_lastTheta");
        render();
    }

    function solve(_numSteps){

        if (globals.shouldAnimateFoldPercent){
            globals.creasePercent = globals.videoAnimator.nextFoldAngle(0);
            globals.controls.updateCreasePercent();
            setCreasePercent(globals.creasePercent);
            globals.shouldChangeCreasePercent = true;
        }

        if (globals.forceHasChanged) {
            updateExternalForces();
            globals.forceHasChanged = false;
        }
        if (globals.fixedHasChanged) {
            updateFixed();
            globals.fixedHasChanged = false;
        }
        if (globals.nodePositionHasChanged) {
            updateLastPosition();
            globals.nodePositionHasChanged = false;　
        }
        if (globals.creaseMaterialHasChanged) {
            updateCreasesMeta();
            globals.creaseMaterialHasChanged = false;
        }
        if (globals.materialHasChanged) {
            updateMaterials();
            globals.materialHasChanged = false;
        }
        if (globals.shouldChangeCreasePercent) {
            setCreasePercent(globals.creasePercent);
            globals.shouldChangeCreasePercent = false;
        }
        // if (globals.shouldZeroDynamicVelocity){
        //     globals.gpuMath.step("zeroTexture", [], "u_velocity");
        //     globals.gpuMath.step("zeroTexture", [], "u_lastVelocity");
        //     globals.shouldZeroDynamicVelocity = false;
        // }
        if (globals.shouldCenterGeo){
            var avgPosition = getAvgPosition();
            globals.gpuMath.setProgram("centerTexture");
            globals.gpuMath.setUniformForProgram("centerTexture", "u_center", [avgPosition.x, avgPosition.y, avgPosition.z], "3f");
            globals.gpuMath.step("centerTexture", ["u_lastPosition"], "u_position");
            if (globals.integrationType == "verlet") globals.gpuMath.step("copyTexture", ["u_position"], "u_lastLastPosition");
            globals.gpuMath.swapTextures("u_position", "u_lastPosition");
            globals.gpuMath.step("zeroTexture", [], "u_lastVelocity");
            globals.gpuMath.step("zeroTexture", [], "u_velocity");
            globals.shouldCenterGeo = false;
        } else {
            if (isErrorPosition()) {
                var avgPosition = getAvgPosition();
                globals.gpuMath.setProgram("centerTexture");
                globals.gpuMath.setUniformForProgram("centerTexture",   "u_center", [avgPosition.x, avgPosition.y, avgPosition.z],    "3f");
                globals.gpuMath.step("centerTexture", ["u_lastPosition"],   "u_position");
                if (globals.integrationType == "verlet") globals.gpuMath.step   ("copyTexture", ["u_position"], "u_lastLastPosition");
                globals.gpuMath.swapTextures("u_position", "u_lastPosition");
                globals.gpuMath.step("zeroTexture", [], "u_lastVelocity");
                globals.gpuMath.step("zeroTexture", [], "u_velocity");
            }
            updateLastPosition();
        }

        if (_numSteps === undefined) _numSteps = globals.numSteps;
        for (var j=0;j<_numSteps;j++){
            solveStep();
        }
        render();
    }

    function solveStep(){

        var gpuMath = globals.gpuMath;

        gpuMath.setProgram("normalCalc");
        gpuMath.setSize(textureDimFaces, textureDimFaces);
        gpuMath.step("normalCalc", ["u_faceVertexIndices", "u_lastPosition", "u_originalPosition"], "u_normals");

        gpuMath.setProgram("thetaCalc");
        gpuMath.setSize(textureDimCreases, textureDimCreases);
        gpuMath.step("thetaCalc", ["u_normals", "u_lastTheta", "u_creaseVectors", "u_lastPosition",
            "u_originalPosition"], "u_theta");

        gpuMath.setProgram("updateCreaseGeo");
        //already at textureDimCreasesxtextureDimCreases
        gpuMath.step("updateCreaseGeo", ["u_lastPosition", "u_originalPosition", "u_creaseMeta2"], "u_creaseGeo");

        if (globals.integrationType == "verlet"){
            gpuMath.setProgram("positionCalcVerlet");
            gpuMath.setSize(textureDim, textureDim);
            gpuMath.step("positionCalcVerlet", ["u_lastPosition", "u_lastLastPosition", "u_lastVelocity", "u_originalPosition", "u_externalForces",
                "u_mass", "u_meta", "u_beamMeta", "u_creaseMeta", "u_nodeCreaseMeta", "u_normals", "u_theta", "u_creaseGeo",
                "u_meta2", "u_nodeFaceMeta", "u_nominalTriangles"], "u_position");
            gpuMath.step("velocityCalcVerlet", ["u_position", "u_lastPosition", "u_mass"], "u_velocity");
            gpuMath.swapTextures("u_lastPosition", "u_lastLastPosition");
        } else {//euler
            gpuMath.setProgram("velocityCalc");
            gpuMath.setSize(textureDim, textureDim);
            gpuMath.step("velocityCalc", ["u_lastPosition", "u_lastVelocity", "u_originalPosition", "u_externalForces",
                "u_mass", "u_meta", "u_beamMeta", "u_creaseMeta", "u_nodeCreaseMeta", "u_normals", "u_theta", "u_creaseGeo",
                "u_meta2", "u_nodeFaceMeta", "u_nominalTriangles"], "u_velocity");
            gpuMath.step("positionCalc", ["u_velocity", "u_lastPosition", "u_mass"], "u_position");
        }

        gpuMath.swapTextures("u_theta", "u_lastTheta");
        gpuMath.swapTextures("u_velocity", "u_lastVelocity");
        gpuMath.swapTextures("u_position", "u_lastPosition");
    }

    let $globalErrorOutput = $("#globalError");
    let $maxErrorOutput = $("#maxError");
    let $averageWarpAngleOutput = $("#averageWarpAngle");

    function getAvgPosition(){
        var xavg = 0;
        var yavg = 0;
        var zavg = 0;
        for (var i=0;i<positions.length;i+=3){
            xavg += positions[i];
            yavg += positions[i+1];
            zavg += positions[i+2];
        }
        var avgPosition = new THREE.Vector3(xavg, yavg, zavg);
        avgPosition.multiplyScalar(3/positions.length);
        return avgPosition;
    }

    function isErrorPosition() {
        let xavg = 0, yavg = 0, zavg = 0;
        for (let i = 0; i < nodes.length; i++) {
            let position = nodes[i].getPosition();
            xavg += position.x;
            yavg += position.y;
            zavg += position.z;
        }
        let avgPosition = new THREE.Vector3(xavg, yavg, zavg);
        avgPosition.multiplyScalar(1/nodes.length);
        if (avgPosition.sub(avgOriginalPosition).lengthSq() > 0.01) {
            console.log("fixed");
            return true;
        }
        return false;
    }

    // モデルが変形をし続けているかを調べる
    function getDiffPosition(){
        let diff = 0;
        for (let i=0; i<nodes.length; i++){
            let _position = nodes[i].getRelativePosition();
            diff += Math.abs((lastPosition[4*i] - _position.x));
            diff += Math.abs((lastPosition[4*i+1] - _position.y));
            diff += Math.abs((lastPosition[4*i+2] - _position.z));
        }
        if (diff < 0.05) {
            return true;
        }
        return false;
    }

    // math.matrixの引き算をする
    // input: v_0, v_1 引き算をするmath.matrixオブジェクト
    // output: 引き算をした結果
    function getDiffVector(v_0, v_1) {
        return math.matrix([v_0._data[0]-v_1._data[0], v_0._data[1]-v_1._data[1], v_0._data[2]-v_1._data[2]]);
    }

    function getWarpAngle() {
        const fold = globals.pattern.getFoldData(true);
        const faces = fold.faces_vertices;
        const edges = fold.edges_vertices;
        const edges_assignments = fold.edges_assignment;

        let sumWarpAngle = 0;
        let count = 0;

        // rigidSolver.js start
        var geometry = globals.model.getGeometry();
        var indices = geometry.index.array;
        var normals = [];
        var thetas = [];

        //compute all normals
        var cb = new THREE.Vector3(), ab = new THREE.Vector3();
        for (var j=0;j<indices.length;j+=3){
            var index = 3*indices[j];
            var vA = new THREE.Vector3(positions[index], positions[index+1], positions[index+2]);
            index = 3*indices[j+1];
            var vB = new THREE.Vector3(positions[index], positions[index+1], positions[index+2]);
            index = 3*indices[j+2];
            var vC = new THREE.Vector3(positions[index], positions[index+1], positions[index+2]);
            cb.subVectors( vC, vB );
            ab.subVectors( vA, vB );
            cb.cross( ab );

            cb.normalize();
            normals.push(cb.clone());
        }

        for (var j=0;j<creases.length;j++){
            var crease = creases[j];
            var normal1 = normals[crease.face1Index];
            var normal2 = normals[crease.face2Index];
            var dotNormals = normal1.dot(normal2);
            if (dotNormals < -1.0) dotNormals = -1.0;
            else if (dotNormals > 1.0) dotNormals = 1.0;

            var creaseVector = crease.getVector().normalize();
            //https://math.stackexchange.com/questions/47059/how-do-i-calculate-a-dihedral-angle-given-cartesian-coordinates
            thetas.push(Math.abs(Math.atan2((normal1.clone().cross(creaseVector)).dot(normal2), dotNormals)*(180/Math.PI)));
        }
        // rigidSolver.js end

        console.log(thetas);

        for (let i = 0; i < creases.length; i++) {
            const crease = creases[i];
            if (crease.type == 1) {
                continue;
            }
            if (thetas[i] < 0.5) {
                console.log(thetas[i]);
                continue;
            }
            const vertex0 = nodes[creaseMeta2[i*4+2]].getPosition();
            let nextvertex0;
            let prevvertex0;
            const vertex1 = nodes[creaseMeta2[i*4+3]].getPosition();
            let nextvertex1;
            let prevvertex1;
            // 角の場合を考慮してない
            for (let j = 0; j < faces.length; j++) {
                const face = faces[j];
                if (face.indexOf(creaseMeta2[i*4+2]) >= 0 && face.indexOf(creaseMeta2[i*4+3]) >= 0) {
                    if (face.indexOf(creaseMeta2[i*4+2]) == 0) {
                        prevvertex0 = nodes[face[face.length-1]].getPosition();
                    } else {
                        prevvertex0 = nodes[face[face.indexOf(creaseMeta2[i*4+2])-1]].getPosition();
                    }
                    if (face.indexOf(creaseMeta2[i*4+2]) == face.length-1) {
                        nextvertex0 = nodes[face[0]].getPosition();
                    } else {
                        nextvertex0 = nodes[face[face.indexOf(creaseMeta2[i*4+2])+1]].getPosition();
                    }
                    if (face.indexOf(creaseMeta2[i*4+3]) == 0) {
                        prevvertex1 = nodes[face[face.length-1]].getPosition();
                    } else {
                        prevvertex1 = nodes[face[face.indexOf(creaseMeta2[i*4+3])-1]].getPosition();
                    }
                    if (face.indexOf(creaseMeta2[i*4+3]) == face.length-1) {
                        nextvertex1 = nodes[face[0]].getPosition();
                    } else {
                        nextvertex1 = nodes[face[face.indexOf(creaseMeta2[i*4+3])+1]].getPosition();
                    }
                    break;
                }
            }
            
            const tangent0 = [nextvertex0['x']-prevvertex0['x'], nextvertex0['y']-prevvertex0['y'], nextvertex0['z']-prevvertex0['z']]; // prevvertex0->nextvertex0
            const tangent1 = [nextvertex1['x']-prevvertex1['x'], nextvertex1['y']-prevvertex1['y'], nextvertex1['z']-prevvertex1['z']]; // prevvertex1->nextvertex1
            const r = [vertex1['x']-vertex0['x'], vertex1['y']-vertex0['y'], vertex1['z']-vertex0['z']]; // vertex0->vertex1
            let n0 =  [tangent0[1]*r[2]-tangent0[2]*r[1], tangent0[2]*r[0]-tangent0[0]*r[2], tangent0[0]*r[1]-tangent0[1]*r[0]];
            const n0size = Math.sqrt(n0[0]*n0[0]+n0[1]*n0[1]+n0[2]*n0[2]);
            n0 = [n0[0]/n0size, n0[1]/n0size, n0[2]/n0size];
            let n1 =  [tangent1[1]*r[2]-tangent1[2]*r[1], tangent1[2]*r[0]-tangent1[0]*r[2], tangent1[0]*r[1]-tangent1[1]*r[0]];
            const n1size = Math.sqrt(n1[0]*n1[0]+n1[1]*n1[1]+n1[2]*n1[2]);
            n1 = [n1[0]/n1size, n1[1]/n1size, n1[2]/n1size];

            const n0xn1 = [n0[1]*n1[2]-n0[2]*n1[1], n0[2]*n1[0]-n0[0]*n1[2], n0[0]*n1[1]-n0[1]*n1[0]];
            const n0xn1size = Math.sqrt(n0xn1[0]*n0xn1[0]+n0xn1[1]*n0xn1[1]+n0xn1[2]*n0xn1[2]);
            const warpAngle = Math.asin(n0xn1size) * (180 / Math.PI); // n0 x n1 = sin(warpAngle)

            // NaNがでていて、それを足すとNaNになる
            if (!isNaN(warpAngle)) {
                sumWarpAngle += warpAngle;
                count++;
            } else {
                console.log(creaseMeta2[i*4+2], creaseMeta2[i*4+3], tangent0, tangent1, n0, n1, n0xn1);
            }
        }

        return sumWarpAngle/count;
    }

    function render(){

        var vectorLength = 4;
        globals.gpuMath.setProgram("packToBytes");
        globals.gpuMath.setUniformForProgram("packToBytes", "u_vectorLength", vectorLength, "1f");
        globals.gpuMath.setUniformForProgram("packToBytes", "u_floatTextureDim", [textureDim, textureDim], "2f");
        globals.gpuMath.setSize(textureDim*vectorLength, textureDim);
        globals.gpuMath.step("packToBytes", ["u_lastPosition"], "outputBytes");

        if (globals.gpuMath.readyToRead()) {
            var numPixels = nodes.length*vectorLength;
            var height = Math.ceil(numPixels/(textureDim*vectorLength));
            var pixels = new Uint8Array(height*textureDim*4*vectorLength);
            globals.gpuMath.readPixels(0, 0, textureDim * vectorLength, height, pixels);
            var parsedPixels = new Float32Array(pixels.buffer);
            var globalError = 0;
            var maxError = 0;
            var shouldUpdateColors = globals.colorMode == "axialStrain";
            for (var i = 0; i < nodes.length; i++) {
                var rgbaIndex = i * vectorLength;
                var nodeError = parsedPixels[rgbaIndex+3]*100;
                globalError += nodeError;
                if (nodeError > maxError) { maxError = nodeError; }
                var nodePosition = new THREE.Vector3(parsedPixels[rgbaIndex], parsedPixels[rgbaIndex + 1], parsedPixels[rgbaIndex + 2]);
                nodePosition.add(nodes[i]._originalPosition);
                positions[3*i] = nodePosition.x;
                positions[3*i+1] = nodePosition.y;
                positions[3*i+2] = nodePosition.z;
                if (shouldUpdateColors){
                    if (nodeError>globals.strainClip) nodeError = globals.strainClip;
                    var scaledVal = (1-nodeError/globals.strainClip) * 0.7;
                    var color = new THREE.Color();
                    color.setHSL(scaledVal, 1, 0.5);
                    colors[3*i] = color.r;
                    colors[3*i+1] = color.g;
                    colors[3*i+2] = color.b;
                }
            }
            $globalErrorOutput.html((globalError/nodes.length).toFixed(7) + " %");
            $maxErrorOutput.html((maxError).toFixed(7) + " %");
            if (getDiffPosition()) {
                $("#start").css('display', 'inline-block');
                $("#stepForwardOptions").css('display', 'inline-block');
                $("#pause").hide();
                globals.model.pause();
                $averageWarpAngleOutput.html(getWarpAngle().toFixed(7));
            }
        } else {
            console.log("shouldn't be here");
        }
    }

    function setSolveParams(){
        var dt = calcDt();
        $("#deltaT").html(dt);
        globals.gpuMath.setProgram("thetaCalc");
        globals.gpuMath.setUniformForProgram("thetaCalc", "u_dt", dt, "1f");
        globals.gpuMath.setProgram("velocityCalc");
        globals.gpuMath.setUniformForProgram("velocityCalc", "u_dt", dt, "1f");
        globals.gpuMath.setProgram("positionCalcVerlet");
        globals.gpuMath.setUniformForProgram("positionCalcVerlet", "u_dt", dt, "1f");
        globals.gpuMath.setProgram("positionCalc");
        globals.gpuMath.setUniformForProgram("positionCalc", "u_dt", dt, "1f");
        globals.gpuMath.setProgram("velocityCalcVerlet");
        globals.gpuMath.setUniformForProgram("velocityCalcVerlet", "u_dt", dt, "1f");
        globals.controls.setDeltaT(dt);
    }

    function calcDt(){
        var maxFreqNat = 0;
        _.each(edges, function(beam){
            if (beam.getNaturalFrequency()>maxFreqNat) maxFreqNat = beam.getNaturalFrequency();
        });
        return (1/(2*Math.PI*maxFreqNat))*0.9;//0.9 of max delta t for good measure
    }

    function initTexturesAndPrograms(gpuMath){

        var vertexShader = document.getElementById("vertexShader").text;

        gpuMath.initTextureFromData("u_position", textureDim, textureDim, "FLOAT", position, true);
        gpuMath.initTextureFromData("u_lastPosition", textureDim, textureDim, "FLOAT", lastPosition, true);
        gpuMath.initTextureFromData("u_lastLastPosition", textureDim, textureDim, "FLOAT", lastLastPosition, true);
        gpuMath.initTextureFromData("u_velocity", textureDim, textureDim, "FLOAT", velocity, true);
        gpuMath.initTextureFromData("u_lastVelocity", textureDim, textureDim, "FLOAT", lastVelocity, true);
        gpuMath.initTextureFromData("u_theta", textureDimCreases, textureDimCreases, "FLOAT", theta, true);
        gpuMath.initTextureFromData("u_lastTheta", textureDimCreases, textureDimCreases, "FLOAT", lastTheta, true);
        gpuMath.initTextureFromData("u_normals", textureDimFaces, textureDimFaces, "FLOAT", normals, true);

        gpuMath.initFrameBufferForTexture("u_position", true);
        gpuMath.initFrameBufferForTexture("u_lastPosition", true);
        gpuMath.initFrameBufferForTexture("u_lastLastPosition", true);
        gpuMath.initFrameBufferForTexture("u_velocity", true);
        gpuMath.initFrameBufferForTexture("u_lastVelocity", true);
        gpuMath.initFrameBufferForTexture("u_theta", true);
        gpuMath.initFrameBufferForTexture("u_lastTheta", true);
        gpuMath.initFrameBufferForTexture("u_normals", true);

        gpuMath.initTextureFromData("u_meta", textureDim, textureDim, "FLOAT", meta, true);
        gpuMath.initTextureFromData("u_meta2", textureDim, textureDim, "FLOAT", meta2, true);
        gpuMath.initTextureFromData("u_nominalTrinagles", textureDimFaces, textureDimFaces, "FLOAT", nominalTriangles, true);
        gpuMath.initTextureFromData("u_nodeCreaseMeta", textureDimNodeCreases, textureDimNodeCreases, "FLOAT", nodeCreaseMeta, true);
        gpuMath.initTextureFromData("u_creaseMeta2", textureDimCreases, textureDimCreases, "FLOAT", creaseMeta2, true);
        gpuMath.initTextureFromData("u_nodeFaceMeta", textureDimNodeFaces, textureDimNodeFaces, "FLOAT", nodeFaceMeta, true);
        gpuMath.initTextureFromData("u_creaseGeo", textureDimCreases, textureDimCreases, "FLOAT", creaseGeo, true);
        gpuMath.initFrameBufferForTexture("u_creaseGeo", true);
        gpuMath.initTextureFromData("u_faceVertexIndices", textureDimFaces, textureDimFaces, "FLOAT", faceVertexIndices, true);
        gpuMath.initTextureFromData("u_nominalTriangles", textureDimFaces, textureDimFaces, "FLOAT", nominalTriangles, true);

        gpuMath.createProgram("positionCalc", vertexShader, document.getElementById("positionCalcShader").text);
        gpuMath.setUniformForProgram("positionCalc", "u_velocity", 0, "1i");
        gpuMath.setUniformForProgram("positionCalc", "u_lastPosition", 1, "1i");
        gpuMath.setUniformForProgram("positionCalc", "u_mass", 2, "1i");
        gpuMath.setUniformForProgram("positionCalc", "u_textureDim", [textureDim, textureDim], "2f");

        gpuMath.createProgram("velocityCalcVerlet", vertexShader, document.getElementById("velocityCalcVerletShader").text);
        gpuMath.setUniformForProgram("velocityCalcVerlet", "u_position", 0, "1i");
        gpuMath.setUniformForProgram("velocityCalcVerlet", "u_lastPosition", 1, "1i");
        gpuMath.setUniformForProgram("velocityCalcVerlet", "u_mass", 2, "1i");
        gpuMath.setUniformForProgram("velocityCalcVerlet", "u_textureDim", [textureDim, textureDim], "2f");

        gpuMath.createProgram("velocityCalc", vertexShader, document.getElementById("velocityCalcShader").text);
        gpuMath.setUniformForProgram("velocityCalc", "u_lastPosition", 0, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_lastVelocity", 1, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_originalPosition", 2, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_externalForces", 3, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_mass", 4, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_meta", 5, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_beamMeta", 6, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_creaseMeta", 7, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_nodeCreaseMeta", 8, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_normals", 9, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_theta", 10, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_creaseGeo", 11, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_meta2", 12, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_nodeFaceMeta", 13, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_nominalTriangles", 14, "1i");
        gpuMath.setUniformForProgram("velocityCalc", "u_textureDim", [textureDim, textureDim], "2f");
        gpuMath.setUniformForProgram("velocityCalc", "u_textureDimEdges", [textureDimEdges, textureDimEdges], "2f");
        gpuMath.setUniformForProgram("velocityCalc", "u_textureDimFaces", [textureDimFaces, textureDimFaces], "2f");
        gpuMath.setUniformForProgram("velocityCalc", "u_textureDimCreases", [textureDimCreases, textureDimCreases], "2f");
        gpuMath.setUniformForProgram("velocityCalc", "u_textureDimNodeCreases", [textureDimNodeCreases, textureDimNodeCreases], "2f");
        gpuMath.setUniformForProgram("velocityCalc", "u_textureDimNodeFaces", [textureDimNodeFaces, textureDimNodeFaces], "2f");
        gpuMath.setUniformForProgram("velocityCalc", "u_creasePercent", globals.creasePercent, "1f");
        gpuMath.setUniformForProgram("velocityCalc", "u_axialStiffness", globals.axialStiffness, "1f");
        gpuMath.setUniformForProgram("velocityCalc", "u_faceStiffness", globals.faceStiffness, "1f");
        gpuMath.setUniformForProgram("velocityCalc", "u_calcFaceStrain", globals.calcFaceStrain, "1f");

        gpuMath.createProgram("positionCalcVerlet", vertexShader, document.getElementById("positionCalcVerletShader").text);
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_lastPosition", 0, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_lastLastPosition", 1, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_lastVelocity", 2, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_originalPosition", 3, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_externalForces", 4, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_mass", 5, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_meta", 6, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_beamMeta", 7, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_creaseMeta", 8, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_nodeCreaseMeta", 9, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_normals", 10, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_theta", 11, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_creaseGeo", 12, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_meta2", 13, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_nodeFaceMeta", 14, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_nominalTriangles", 15, "1i");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_textureDim", [textureDim, textureDim], "2f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_textureDimEdges", [textureDimEdges, textureDimEdges], "2f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_textureDimFaces", [textureDimFaces, textureDimFaces], "2f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_textureDimCreases", [textureDimCreases, textureDimCreases], "2f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_textureDimNodeCreases", [textureDimNodeCreases, textureDimNodeCreases], "2f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_textureDimNodeFaces", [textureDimNodeFaces, textureDimNodeFaces], "2f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_creasePercent", globals.creasePercent, "1f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_axialStiffness", globals.axialStiffness, "1f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_faceStiffness", globals.faceStiffness, "1f");
        gpuMath.setUniformForProgram("positionCalcVerlet", "u_calcFaceStrain", globals.calcFaceStrain, "1f");

        gpuMath.createProgram("thetaCalc", vertexShader, document.getElementById("thetaCalcShader").text);
        gpuMath.setUniformForProgram("thetaCalc", "u_normals", 0, "1i");
        gpuMath.setUniformForProgram("thetaCalc", "u_lastTheta", 1, "1i");
        gpuMath.setUniformForProgram("thetaCalc", "u_creaseVectors", 2, "1i");
        gpuMath.setUniformForProgram("thetaCalc", "u_lastPosition", 3, "1i");
        gpuMath.setUniformForProgram("thetaCalc", "u_originalPosition", 4, "1i");
        gpuMath.setUniformForProgram("thetaCalc", "u_textureDim", [textureDim, textureDim], "2f");
        gpuMath.setUniformForProgram("thetaCalc", "u_textureDimFaces", [textureDimFaces, textureDimFaces], "2f");
        gpuMath.setUniformForProgram("thetaCalc", "u_textureDimCreases", [textureDimCreases, textureDimCreases], "2f");

        gpuMath.createProgram("normalCalc", vertexShader, document.getElementById("normalCalc").text);
        gpuMath.setUniformForProgram("normalCalc", "u_faceVertexIndices", 0, "1i");
        gpuMath.setUniformForProgram("normalCalc", "u_lastPosition", 1, "1i");
        gpuMath.setUniformForProgram("normalCalc", "u_originalPosition", 2, "1i");
        gpuMath.setUniformForProgram("normalCalc", "u_textureDim", [textureDim, textureDim], "2f");
        gpuMath.setUniformForProgram("normalCalc", "u_textureDimFaces", [textureDimFaces, textureDimFaces], "2f");

        gpuMath.createProgram("packToBytes", vertexShader, document.getElementById("packToBytesShader").text);
        gpuMath.initTextureFromData("outputBytes", textureDim*4, textureDim, "UNSIGNED_BYTE", null, true);
        gpuMath.initFrameBufferForTexture("outputBytes", true);
        gpuMath.setUniformForProgram("packToBytes", "u_floatTextureDim", [textureDim, textureDim], "2f");
        gpuMath.setUniformForProgram("packToBytes", "u_floatTexture", 0, "1i");

        gpuMath.createProgram("zeroTexture", vertexShader, document.getElementById("zeroTexture").text);
        gpuMath.createProgram("zeroThetaTexture", vertexShader, document.getElementById("zeroThetaTexture").text);
        gpuMath.setUniformForProgram("zeroThetaTexture", "u_theta", 0, "1i");
        gpuMath.setUniformForProgram("zeroThetaTexture", "u_textureDimCreases", [textureDimCreases, textureDimCreases], "2f");

        gpuMath.createProgram("centerTexture", vertexShader, document.getElementById("centerTexture").text);
        gpuMath.setUniformForProgram("centerTexture", "u_lastPosition", 0, "1i");
        gpuMath.setUniformForProgram("centerTexture", "u_textureDim", [textureDim, textureDim], "2f");

        gpuMath.createProgram("copyTexture", vertexShader, document.getElementById("copyTexture").text);
        gpuMath.setUniformForProgram("copyTexture", "u_orig", 0, "1i");
        gpuMath.setUniformForProgram("copyTexture", "u_textureDim", [textureDim, textureDim], "2f");

        gpuMath.createProgram("updateCreaseGeo", vertexShader, document.getElementById("updateCreaseGeo").text);
        gpuMath.setUniformForProgram("updateCreaseGeo", "u_lastPosition", 0, "1i");
        gpuMath.setUniformForProgram("updateCreaseGeo", "u_originalPosition", 1, "1i");
        gpuMath.setUniformForProgram("updateCreaseGeo", "u_creaseMeta2", 2, "1i");
        gpuMath.setUniformForProgram("updateCreaseGeo", "u_textureDim", [textureDim, textureDim], "2f");
        gpuMath.setUniformForProgram("updateCreaseGeo", "u_textureDimCreases", [textureDimCreases, textureDimCreases], "2f");

        gpuMath.setSize(textureDim, textureDim);

        programsInited = true;
    }

    function calcTextureSize(numNodes){
        if (numNodes == 1) return 2;
        for (var i=0;i<numNodes;i++){
            if (Math.pow(2, 2*i) >= numNodes){
                return Math.pow(2, i);
            }
        }
        console.warn("no texture size found for " + numNodes + " items");
        return 2;
    }

    function updateMaterials(initing){
        var index = 0;
        for (var i=0;i<nodes.length;i++){
            if (initing) {
                meta[4*i] = index;
                meta[4*i+1] = nodes[i].numBeams();
            }
            for (var j=0;j<nodes[i].beams.length;j++){
                var beam = nodes[i].beams[j];
                beamMeta[4*index] = beam.getK();
                beamMeta[4*index+1] = beam.getD();
                if (initing) {
                    beamMeta[4*index+2] = beam.getLength();
                    beamMeta[4*index+3] = beam.getOtherNode(nodes[i]).getIndex();
                }
                index+=1;
            }
        }
        globals.gpuMath.initTextureFromData("u_beamMeta", textureDimEdges, textureDimEdges, "FLOAT", beamMeta, true);


        if (programsInited) {
            globals.gpuMath.setProgram("velocityCalc");
            globals.gpuMath.setUniformForProgram("velocityCalc", "u_axialStiffness", globals.axialStiffness, "1f");
            globals.gpuMath.setUniformForProgram("velocityCalc", "u_faceStiffness", globals.faceStiffness, "1f");
            globals.gpuMath.setProgram("positionCalcVerlet");
            globals.gpuMath.setUniformForProgram("positionCalcVerlet", "u_axialStiffness", globals.axialStiffness, "1f");
            globals.gpuMath.setUniformForProgram("positionCalcVerlet", "u_faceStiffness", globals.faceStiffness, "1f");
            setSolveParams();//recalc dt
        }
    }

    function updateExternalForces(){
        for (var i=0;i<nodes.length;i++){
            var externalForce = nodes[i].getExternalForce();
            externalForces[4*i] = externalForce.x;
            externalForces[4*i+1] = externalForce.y;
            externalForces[4*i+2] = externalForce.z;
        }
        globals.gpuMath.initTextureFromData("u_externalForces", textureDim, textureDim, "FLOAT", externalForces, true);
    }

    function updateFixed(){
        for (var i=0;i<nodes.length;i++){
            mass[4*i+1] = (nodes[i].isFixed() ? 1 : 0);
        }
        globals.gpuMath.initTextureFromData("u_mass", textureDim, textureDim, "FLOAT", mass, true);
    }

    function updateOriginalPosition(){
        for (var i=0;i<nodes.length;i++){
            var origPosition = nodes[i].getOriginalPosition();
            originalPosition[4*i] = origPosition.x;
            originalPosition[4*i+1] = origPosition.y;
            originalPosition[4*i+2] = origPosition.z;
        }
        globals.gpuMath.initTextureFromData("u_originalPosition", textureDim, textureDim, "FLOAT", originalPosition, true);
    }

    function updateCreaseVectors(){
        for (var i=0;i<creases.length;i++){
            var rgbaIndex = i*4;
            var nodes = creases[i].edge.nodes;
            // this.vertices[1].clone().sub(this.vertices[0]);
            creaseVectors[rgbaIndex] = nodes[0].getIndex();
            creaseVectors[rgbaIndex+1] = nodes[1].getIndex();
        }
        globals.gpuMath.initTextureFromData("u_creaseVectors", textureDimCreases, textureDimCreases, "FLOAT", creaseVectors, true);
    }

    function updateCreasesMeta(initing){
        for (var i=0;i<creases.length;i++){
            var crease = creases[i];
            creaseMeta[i*4] = crease.getK();
            // creaseMeta[i*4+1] = crease.getD();
            if (initing) creaseMeta[i*4+2] = crease.getTargetTheta();
        }
        globals.gpuMath.initTextureFromData("u_creaseMeta", textureDimCreases, textureDimCreases, "FLOAT", creaseMeta, true);
    }

    function updateLastPosition(){
        for (var i=0;i<nodes.length;i++){
            var _position = nodes[i].getRelativePosition();
            lastPosition[4*i] = _position.x;
            lastPosition[4*i+1] = _position.y;
            lastPosition[4*i+2] = _position.z;
        }
        globals.gpuMath.initTextureFromData("u_lastPosition", textureDim, textureDim, "FLOAT", lastPosition, true);
        globals.gpuMath.initFrameBufferForTexture("u_lastPosition", true);

    }

    function setCreasePercent(percent){
        if (!programsInited) return;
        globals.gpuMath.setProgram("velocityCalc");
        globals.gpuMath.setUniformForProgram("velocityCalc", "u_creasePercent", percent, "1f");
        globals.gpuMath.setProgram("positionCalcVerlet");
        globals.gpuMath.setUniformForProgram("positionCalcVerlet", "u_creasePercent", percent, "1f");
    }

    function initTypedArrays(){

        textureDim = calcTextureSize(nodes.length);

        var numNodeFaces = 0;
        var nodeFaces = [];
        for (var i=0;i<nodes.length;i++){
            nodeFaces.push([]);
            for (var j=0;j<faces.length;j++){
                if (faces[j].indexOf(i)>=0) {
                    nodeFaces[i].push(j);
                    numNodeFaces++;
                }
            }
        }
        textureDimNodeFaces = calcTextureSize(numNodeFaces);

        var numEdges = 0;
        for (var i=0;i<nodes.length;i++){
            numEdges += nodes[i].numBeams();
        }
        textureDimEdges = calcTextureSize(numEdges);

        var numCreases = creases.length;
        textureDimCreases = calcTextureSize(numCreases);

        var numNodeCreases = 0;
        for (var i=0;i<nodes.length;i++){
            numNodeCreases += nodes[i].numCreases();
        }
        numNodeCreases += numCreases*2;//reactions
        textureDimNodeCreases = calcTextureSize(numNodeCreases);

        var numFaces = faces.length;
        textureDimFaces = calcTextureSize(numFaces);

        originalPosition = new Float32Array(textureDim*textureDim*4);
        position = new Float32Array(textureDim*textureDim*4);
        lastPosition = new Float32Array(textureDim*textureDim*4);
        lastLastPosition = new Float32Array(textureDim*textureDim*4);
        velocity = new Float32Array(textureDim*textureDim*4);
        lastVelocity = new Float32Array(textureDim*textureDim*4);
        externalForces = new Float32Array(textureDim*textureDim*4);
        mass = new Float32Array(textureDim*textureDim*4);
        meta = new Float32Array(textureDim*textureDim*4);
        meta2 = new Float32Array(textureDim*textureDim*4);
        beamMeta = new Float32Array(textureDimEdges*textureDimEdges*4);

        normals = new Float32Array(textureDimFaces*textureDimFaces*4);
        faceVertexIndices = new Float32Array(textureDimFaces*textureDimFaces*4);
        creaseMeta = new Float32Array(textureDimCreases*textureDimCreases*4);
        nodeFaceMeta = new Float32Array(textureDimNodeFaces*textureDimNodeFaces*4);
        nominalTriangles = new Float32Array(textureDimFaces*textureDimFaces*4);
        nodeCreaseMeta = new Float32Array(textureDimNodeCreases*textureDimNodeCreases*4);
        creaseMeta2 = new Float32Array(textureDimCreases*textureDimCreases*4);
        creaseGeo = new Float32Array(textureDimCreases*textureDimCreases*4);
        creaseVectors = new Float32Array(textureDimCreases*textureDimCreases*4);
        theta = new Float32Array(textureDimCreases*textureDimCreases*4);
        lastTheta = new Float32Array(textureDimCreases*textureDimCreases*4);

        area = new Float32Array(numFaces);

        for (var i=0;i<faces.length;i++){
            var face = faces[i];
            faceVertexIndices[4*i] = face[0];
            faceVertexIndices[4*i+1] = face[1];
            faceVertexIndices[4*i+2] = face[2];

            var a = nodes[face[0]].getOriginalPosition();
            var b = nodes[face[1]].getOriginalPosition();
            var c = nodes[face[2]].getOriginalPosition();
            var ab = (b.clone().sub(a)).normalize();
            var ac = (c.clone().sub(a)).normalize();
            var bc = (c.clone().sub(b)).normalize();
            nominalTriangles[4*i] = Math.acos(ab.dot(ac));
            nominalTriangles[4*i+1] = Math.acos(-1*ab.dot(bc));
            nominalTriangles[4*i+2] = Math.acos(ac.dot(bc));

            if (Math.abs(nominalTriangles[4*i]+nominalTriangles[4*i+1]+nominalTriangles[4*i+2]-Math.PI)>0.1){
                console.warn("bad angles");
            }
        }


        for (var i=0;i<textureDim*textureDim;i++){
            mass[4*i+1] = 1;//set all fixed by default
        }

        for (var i=0;i<textureDimCreases*textureDimCreases;i++){
            if (i >= numCreases){
                lastTheta[i*4+2] = -1;
                lastTheta[i*4+3] = -1;
                continue;
            }
            lastTheta[i*4+2] = creases[i].getNormal1Index();
            lastTheta[i*4+3] = creases[i].getNormal2Index();
        }

        var index = 0;
        for (var i=0;i<nodes.length;i++){
            meta2[4*i] = index;
            var num = nodeFaces[i].length;
            meta2[4*i+1] = num;
            for (var j=0;j<num;j++){
                var _index = (index+j)*4;
                var face = faces[nodeFaces[i][j]];
                nodeFaceMeta[_index] = nodeFaces[i][j];
                nodeFaceMeta[_index+1] = face[0] == i ? -1 : face[0];
                nodeFaceMeta[_index+2] = face[1] == i ? -1 : face[1];
                nodeFaceMeta[_index+3] = face[2] == i ? -1 : face[2];
            }
            index+=num;
        }

        var index = 0;
        for (var i=0;i<nodes.length;i++){
            mass[4*i] = nodes[i].getSimMass();
            meta[i*4+2] = index;
            var nodeCreases = nodes[i].creases;
            var nodeInvCreases = nodes[i].invCreases;//nodes attached to crease move in opposite direction
            // console.log(nodeInvCreases);
            meta[i*4+3] = nodeCreases.length + nodeInvCreases.length;
            for (var j=0;j<nodeCreases.length;j++){
                nodeCreaseMeta[index*4] = nodeCreases[j].getIndex();
                nodeCreaseMeta[index*4+1] = nodeCreases[j].getNodeIndex(nodes[i]);//type 1, 2, 3, 4
                index++;
            }
            for (var j=0;j<nodeInvCreases.length;j++){
                nodeCreaseMeta[index*4] = nodeInvCreases[j].getIndex();
                nodeCreaseMeta[index*4+1] = nodeInvCreases[j].getNodeIndex(nodes[i]);//type 1, 2, 3, 4
                index++;
            }
        }
        for (var i=0;i<creases.length;i++){
            var crease = creases[i];
            creaseMeta2[i*4] = crease.node1.getIndex();
            creaseMeta2[i*4+1] = crease.node2.getIndex();
            creaseMeta2[i*4+2] = crease.edge.nodes[0].getIndex();
            creaseMeta2[i*4+3] = crease.edge.nodes[1].getIndex();
            index++;
        }

        updateOriginalPosition();
        updateMaterials(true);
        updateFixed();
        updateExternalForces();
        updateCreasesMeta(true);
        updateCreaseVectors();
        setCreasePercent(globals.creasePercent);
    }

    return {
        syncNodesAndEdges: syncNodesAndEdges,
        updateFixed: updateFixed,
        solve: solve,
        render: render,
        reset: reset,
    }
}
