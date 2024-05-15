# Croquet Brain Demo

## Introduction

The Croquet Demo loads the 3D model of a brain scan and allows a group of users to rotate, slice, and annotate the model collaboratively.

## Code Organization

The Croquet View uses THREE.js to render the model. There are some additional files to load NNRD files in the `assets` directory` and a modified shader in `thirdparty` and `thirdparty-patched` but otherwise it is unchanged.

You need to create a file called `apiKey.js` by copying apyKey.js-example and replace the value with your apiKey obtained from [Croquet Dev Portal](https://croquet.io/keys):

   ```JavaScript
   const apiKey = "<insert your apiKey from croquet.io/keys>";
   export default apiKey;
   ```

## Running The Brain Demo

Run `npm install` and then run `npm start` that runs a local Parcel server at localhost:9009.

A command:

   npx parcel build $HTML --dist-dir target-dir --public-url .

generates a directory that can be deployed under `target-dir` (or any directory of your choice). You can simply copy the directory to your server.
