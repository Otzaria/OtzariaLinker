import fc from "fast-check";

/*
 * Property tests explore random inputs. Locally every run is different (more ground covered); set
 * FC_SEED to replay a failure exactly. CI and release set FC_SEED from the commit, so a red build
 * reproduces bit for bit, while different commits still explore different inputs. On failure
 * fast-check prints the seed and path either way.
 */
const seed = Number(process.env.FC_SEED);
if (Number.isInteger(seed)) fc.configureGlobal({ seed });
