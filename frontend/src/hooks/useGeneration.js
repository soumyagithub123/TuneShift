import { useEffect, useState } from 'react';
import { aiEditProject, editProject, fetchProject, fetchStatus, startGeneration } from '../api/tunes';

const POLL_MS = 2000;

export function useGeneration() {
  const [jobId, setJobId] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  const [project, setProject] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [aiReply, setAiReply] = useState(null);

  useEffect(() => {
    if (!jobId || !isGenerating) return;

    const timer = setInterval(async () => {
      try {
        const data = await fetchStatus(jobId);
        setStatusMessage(data.message);
        if (data.status === 'completed') {
          setProject(await fetchProject(jobId));
          setIsGenerating(false);
        } else if (data.status === 'failed') {
          setIsGenerating(false);
          alert('Generation failed: ' + data.message);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [jobId, isGenerating]);

  const generate = async (params) => {
    setIsGenerating(true);
    setStatusMessage('Uploading...');
    setProject(null);
    setAiReply(null);
    try {
      const data = await startGeneration(params);
      setJobId(data.job_id);
    } catch (err) {
      alert(err.message);
      setIsGenerating(false);
    }
  };

  const runEdit = async (action) => {
    setIsEditing(true);
    try {
      await action();
    } catch (err) {
      alert(err.message);
    } finally {
      setIsEditing(false);
    }
  };

  const edit = (ops) => runEdit(async () => setProject(await editProject(jobId, ops)));

  const aiEdit = (instruction) =>
    runEdit(async () => {
      const data = await aiEditProject(jobId, instruction);
      setProject(data.project);
      setAiReply(data.reply);
    });

  const reset = () => {
    setProject(null);
    setAiReply(null);
  };

  return { jobId, generate, reset, edit, aiEdit, isGenerating, isEditing, statusMessage, project, aiReply };
}
