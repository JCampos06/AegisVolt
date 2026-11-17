# Worker de Prefect con las dependencias de los flows de AegisVolt.
FROM prefecthq/prefect:3.9.1-python3.12

COPY requirements.txt /opt/prefect/requirements.txt
RUN pip install --no-cache-dir -r /opt/prefect/requirements.txt

WORKDIR /opt/prefect
COPY prefect.yaml ./prefect.yaml
COPY flows ./flows
# Los flows importan flows/common.py
ENV PYTHONPATH=/opt/prefect/flows
